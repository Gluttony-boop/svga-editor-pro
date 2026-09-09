import { afterEach, describe, expect, it, vi } from 'vitest'
import { Window } from '@tauri-apps/api/window'
import type { CloseRequestedEvent } from '@tauri-apps/api/window'
import capability from '../../src-tauri/capabilities/default.json'
import { createWindowCloseHandler } from './window-close'

afterEach(() => { vi.unstubAllGlobals() })

describe('packaged main window close permissions', () => {
  it('permits the actual SDK close-request path to finish destroying the window', async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === 'plugin:window|destroy' && !capability.permissions.includes('core:window:allow-destroy')) {
        throw new Error('window.destroy not allowed by main capability')
      }
    })
    vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke } })
    let dispatch: ((event: { event:string; id:number; payload:null }) => Promise<void>) | undefined
    const windowHandle = {
      label: 'main',
      listen: vi.fn(async (_name, handler) => { dispatch = handler; return () => {} }),
      destroy: () => Window.prototype.destroy.call(windowHandle as unknown as Window)
    }
    await Window.prototype.onCloseRequested.call(windowHandle as unknown as Window, async (_event: CloseRequestedEvent) => {})
    await expect(dispatch!({ event:'tauri://close-requested', id:1, payload:null })).resolves.toBeUndefined()
    expect(invoke).toHaveBeenCalledWith('plugin:window|destroy', { label:'main' }, undefined)
  })
})

describe('unsaved close state machine', () => {
  const setup = (dirty = true) => {
    const options = { isDirty: () => dirty, confirm: vi.fn(async () => 'discard' as const), save: vi.fn(async () => true), destroy: vi.fn(async () => {}), onError: vi.fn() }
    return { options, ...createWindowCloseHandler(options) }
  }
  it('closes a clean document once without confirmation or saving', async () => {
    const { handle, options } = setup(false)
    const preventDefault = vi.fn()
    await handle({preventDefault})
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(options.confirm).not.toHaveBeenCalled()
    expect(options.save).not.toHaveBeenCalled()
    expect(options.destroy).toHaveBeenCalledOnce()
  })
  it.each(['discard', 'save', 'cancel'] as const)('respects the %s choice', async choice => {
    const options = { isDirty: () => true, confirm: async () => choice, save: vi.fn(async () => true), destroy: vi.fn(async () => {}), onError: vi.fn() }
    await createWindowCloseHandler(options).handle({preventDefault:vi.fn()})
    expect(options.save).toHaveBeenCalledTimes(choice === 'save' ? 1 : 0)
    expect(options.destroy).toHaveBeenCalledTimes(choice === 'cancel' ? 0 : 1)
  })
  it('keeps the window open if saving is cancelled or fails', async () => {
    const options = {isDirty: () => true, confirm: async () => 'save' as const, save: vi.fn(async () => false), destroy: vi.fn(async () => {}), onError: vi.fn()}
    const {handle} = createWindowCloseHandler(options)
    await handle({preventDefault:vi.fn()})
    expect(options.destroy).not.toHaveBeenCalled()
    options.save.mockRejectedValueOnce(new Error('disk full'))
    await handle({preventDefault:vi.fn()})
    expect(options.destroy).not.toHaveBeenCalled()
    expect(options.onError).toHaveBeenCalledWith(expect.objectContaining({message:'disk full'}))
  })
  it('coalesces repeated requests while a confirmation is open', async () => {
    let resolve!: (value: 'discard') => void
    const options = { isDirty: () => true, confirm: vi.fn(() => new Promise<'discard'>(done => {resolve=done})), save: vi.fn(async () => true), destroy: vi.fn(async () => {}), onError: vi.fn() }
    const {handle} = createWindowCloseHandler(options)
    const event = {preventDefault:vi.fn()}
    const first = handle(event)
    await handle(event)
    expect(options.confirm).toHaveBeenCalledOnce()
    expect(event.preventDefault).toHaveBeenCalledTimes(2)
    resolve('discard'); await first
    expect(options.destroy).toHaveBeenCalledOnce()
  })
  it('surfaces native rejection and permits a later retry', async () => {
    const {handle, options} = setup(false)
    options.destroy.mockRejectedValueOnce(new Error('permission denied'))
    await handle({preventDefault:vi.fn()})
    expect(options.onError).toHaveBeenCalledOnce()
    await handle({preventDefault:vi.fn()})
    expect(options.destroy).toHaveBeenCalledTimes(2)
  })
  it('does not close after its listener has been disposed', async () => {
    let resolve!: (value: 'discard') => void
    const destroy = vi.fn(async () => {})
    const controller = createWindowCloseHandler({isDirty:()=>true,confirm:()=>new Promise<'discard'>(done=>{resolve=done}),save:async()=>true,destroy,onError:vi.fn()})
    const pending = controller.handle({preventDefault:vi.fn()})
    controller.dispose(); resolve('discard'); await pending
    expect(destroy).not.toHaveBeenCalled()
  })
  it('keeps duplicate requests blocked until the save has finished', async () => {
    let finishSave!: (saved: boolean) => void
    const options = {isDirty:()=>true,confirm:vi.fn(async ()=>'save' as const),save:vi.fn(()=>new Promise<boolean>(done=>{finishSave=done})),destroy:vi.fn(async()=>{}),onError:vi.fn()}
    const {handle}=createWindowCloseHandler(options)
    const first=handle({preventDefault:vi.fn()})
    await vi.waitFor(() => expect(options.save).toHaveBeenCalledOnce())
    await handle({preventDefault:vi.fn()})
    expect(options.save).toHaveBeenCalledOnce()
    expect(options.destroy).not.toHaveBeenCalled()
    finishSave(true); await first
    expect(options.destroy).toHaveBeenCalledOnce()
  })
  it('does not let the SDK issue a second destroy after the guarded handler returns', async () => {
    let dispatch!: (event:{event:string;id:number;payload:null})=>Promise<void>
    const destroy = vi.fn(async()=>{})
    const handle = createWindowCloseHandler({isDirty:()=>false,confirm:async()=>'cancel',save:async()=>false,destroy,onError:vi.fn()}).handle
    const native = {listen:async (_event:string,callback:typeof dispatch)=>{dispatch=callback;return ()=>{}},destroy}
    await Window.prototype.onCloseRequested.call(native as unknown as Window,handle)
    await dispatch({event:'tauri://close-requested',id:1,payload:null})
    expect(destroy).toHaveBeenCalledOnce()
  })
})
