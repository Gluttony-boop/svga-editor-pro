/**
 * PixiJS SVGA renderer.
 *
 * This renderer follows the player-style model: build textures, display lists
 * and a persistent sprite pool up front; frame playback only mutates visible,
 * alpha, texture and transform state on existing display objects.
 */

import { Application, Assets, Container, Matrix, Sprite, Texture } from 'pixi.js'
import type { BLEND_MODES } from 'pixi.js'
import type { FrameData, Layer, SlotConfig, VideoItem } from '@/types'
import type { RenderOptions } from '@/core/renderer'
import { AnimationEngine } from '@/core/animation-engine'

type PixiTransform = {
  a: number
  b: number
  c: number
  d: number
  tx: number
  ty: number
}

type LayerRenderState = {
  visible: boolean
  opacity: number
}

type FrameDisplayItem = {
  spriteIndex: number
  imageKey: string
  matteKey?: string
  transform: PixiTransform
  width: number
  height: number
  alpha: number
  blendMode: BLEND_MODES
}

type SpriteNode = {
  container: Container
  sprite: Sprite
  matrix: Matrix
  maskContainer: Container
  maskSprite: Sprite
  maskMatrix: Matrix
  maskTexture: Texture | null
  maskWidth: number
  maskHeight: number
  texture: Texture | null
  width: number
  height: number
  blendMode: BLEND_MODES
}

export class SVGAPixiRenderer {
  private app: Application | null = null
  private appReady: Promise<void>
  private container: HTMLElement
  private stage: Container = new Container()

  private videoItem: VideoItem | null = null
  private textureCache: Map<string, Texture> = new Map()
  private slotTextures: Map<string, Texture> = new Map()
  private slotTextureUrls: Map<string, string> = new Map()
  private pendingSlotTextureUrls: Map<string, string> = new Map()
  private newImageCache: Map<string, Texture> = new Map()

  private spriteNodes: SpriteNode[] = []
  private displayLists: FrameDisplayItem[][] = []
  private layerStates: Array<LayerRenderState | undefined> = []
  private layerStatesSource: Layer[] | null = null
  private layerStatesSignature = ''

  private _currentFrame = 0
  private lastFrameIndex = -1
  private lastLayersHash = ''
  private lastSlotSignature = ''
  private activeSpriteIndices: number[] = []
  private nextActiveSpriteIndices: number[] = []
  private visibleSpriteMarks = new Uint32Array(0)
  private visibilityGeneration = 0
  private lastRenderTime = 0
  private renderCount = 0
  private fps = 0
  private lastFpsUpdate = 0
  private cacheHits = 0
  private cacheMisses = 0
  private renderedSpriteCount = 0

  get currentFrame(): number {
    return this._currentFrame
  }

  constructor(container: HTMLElement) {
    this.container = container
    this.stage.sortableChildren = false
    this.stage.eventMode = 'none'
    this.appReady = this.initApp()
  }

  private async initApp(): Promise<void> {
    this.app = new Application()
    await this.app.init({
      autoStart: false,
      backgroundAlpha: 0,
      clearBeforeRender: true,
      antialias: false,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
      preference: 'webgl'
    })

    const canvas = this.app.canvas as HTMLCanvasElement
    canvas.style.display = 'block'
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    this.container.replaceChildren(canvas)
    this.app.stage.addChild(this.stage)

    if (this.videoItem?.movie?.params) {
      const { viewBoxWidth, viewBoxHeight } = this.videoItem.movie.params
      this.resize(viewBoxWidth, viewBoxHeight)
      this.renderFrame(0)
    }
  }

  async setVideoItem(videoItem: VideoItem | null, _options?: { waitForImages?: boolean }): Promise<void> {
    this.videoItem = videoItem
    this.resetVideoState()

    await this.appReady
    if (!videoItem || !videoItem.movie.params) {
      this.app?.render()
      return
    }

    const { images, movie } = videoItem
    for (const [key, img] of Object.entries(images || {})) {
      if (img instanceof HTMLImageElement && img.complete && img.width > 0) {
        this.textureCache.set(key, Texture.from(img))
      }
    }

    this.precomputeDisplayLists()
    this.buildSpriteNodes()

    const { viewBoxWidth, viewBoxHeight } = movie.params
    this.resize(viewBoxWidth, viewBoxHeight)
    this.renderFrame(0)
  }

  renderFrame(frameIndex: number, options: RenderOptions = {}): void {
    if (!this.app) {
      this.appReady.then(() => this.renderFrame(frameIndex, options))
      return
    }

    const startTime = performance.now()
    const { applySlots = true, slotConfigs = {}, layers = [] } = options
    if (!this.videoItem || this.displayLists.length === 0) return

    this.prepareSlotTextures(slotConfigs, applySlots)

    const layersHash = this.getLayersHash(layers)
    const slotSignature = this.getSlotSignature(slotConfigs, applySlots)
    if (
      frameIndex === this.lastFrameIndex &&
      layersHash === this.lastLayersHash &&
      slotSignature === this.lastSlotSignature
    ) {
      this.cacheHits++
      return
    }
    this.cacheMisses++

    const frameItems = this.displayLists[frameIndex] || []
    const layerStates = this.getLayerStates(layers)
    const itemsByImageKey = this.getFrameItemsByImageKey(frameItems)

    let spriteCount = 0
    const generation = this.nextVisibilityGeneration()
    const nextActive = this.nextActiveSpriteIndices
    nextActive.length = 0

    for (const item of frameItems) {
      const node = this.spriteNodes[item.spriteIndex]
      if (!node) continue

      const layerState = layerStates[item.spriteIndex]
      if (layerState && !layerState.visible) continue

      const texture = this.slotTextures.get(item.imageKey) || this.textureCache.get(item.imageKey)
      if (!texture || texture === Texture.EMPTY) continue

      const alpha = item.alpha * (layerState?.opacity ?? 1)
      if (alpha <= 0) continue

      this.visibleSpriteMarks[item.spriteIndex] = generation
      nextActive.push(item.spriteIndex)

      if (node.texture !== texture) {
        node.sprite.texture = texture
        node.texture = texture
        node.width = -1
        node.height = -1
      }
      if (node.width !== item.width) {
        node.sprite.width = item.width
        node.width = item.width
      }
      if (node.height !== item.height) {
        node.sprite.height = item.height
        node.height = item.height
      }
      if (node.blendMode !== item.blendMode) {
        node.sprite.blendMode = item.blendMode
        node.blendMode = item.blendMode
      }

      const matteItem = item.matteKey ? itemsByImageKey.get(item.matteKey) : undefined
      const maskApplied = matteItem ? this.updateMaskNode(node, matteItem) : false
      if (!maskApplied && node.container.mask) {
        node.container.mask = null
        node.maskContainer.visible = false
      }

      node.matrix.a = item.transform.a
      node.matrix.b = item.transform.b
      node.matrix.c = item.transform.c
      node.matrix.d = item.transform.d
      node.matrix.tx = item.transform.tx
      node.matrix.ty = item.transform.ty
      node.container.setFromMatrix(node.matrix)
      node.container.alpha = alpha
      node.container.visible = true
      spriteCount++
    }

    for (const spriteIndex of this.activeSpriteIndices) {
      if (this.visibleSpriteMarks[spriteIndex] === generation) continue
      const node = this.spriteNodes[spriteIndex]
      if (node) {
        node.container.visible = false
        node.maskContainer.visible = false
      }
    }

    const previousActive = this.activeSpriteIndices
    this.activeSpriteIndices = nextActive
    this.nextActiveSpriteIndices = previousActive

    this.renderNewLayers(layers, frameIndex)

    this._currentFrame = frameIndex
    this.lastFrameIndex = frameIndex
    this.lastLayersHash = layersHash
    this.lastSlotSignature = slotSignature
    this.renderedSpriteCount = spriteCount
    this.lastRenderTime = performance.now() - startTime
    this.recordFps()
    this.app.render()
  }

  async renderFrameAsync(frameIndex: number, options: RenderOptions = {}): Promise<void> {
    await this.appReady
    this.renderFrame(frameIndex, options)
  }

  hasVideoData(): boolean {
    return this.videoItem !== null && this.displayLists.length > 0 && this.spriteNodes.length > 0
  }

  getPerformanceMetrics(): {
    fps: number
    lastRenderTime: number
    cacheSize: number
    workerEnabled: boolean
    cacheHits: number
    cacheMisses: number
    spriteCount: number
  } {
    return {
      fps: this.fps,
      lastRenderTime: this.lastRenderTime,
      cacheSize: this.displayLists.length,
      workerEnabled: false,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      spriteCount: this.renderedSpriteCount
    }
  }

  async exportFrame(format: string = 'image/png', quality: number = 1): Promise<Blob> {
    await this.appReady
    if (!this.app) throw new Error('Pixi renderer is not initialized')

    return new Promise((resolve, reject) => {
      const canvas = this.app!.renderer.extract.canvas(this.stage) as HTMLCanvasElement
      canvas.toBlob(
        (blob) => blob ? resolve(blob) : reject(new Error('导出帧失败')),
        format,
        quality
      )
    })
  }

  resize(width: number, height: number): void {
    if (!this.app) return
    this.app.renderer.resize(width, height)
    const canvas = this.app.canvas as HTMLCanvasElement
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
    this.app.render()
  }

  clearAllCaches(): void {
    this.resetVideoState()
  }

  destroy(): void {
    this.resetVideoState()
    if (this.app) {
      this.app.destroy(true)
      this.app = null
    }
  }

  private resetVideoState(): void {
    this.stage.removeChildren()
    this.textureCache.clear()
    this.slotTextures.clear()
    this.slotTextureUrls.clear()
    this.pendingSlotTextureUrls.clear()
    this.newImageCache.clear()
    this.spriteNodes = []
    this.displayLists = []
    this.layerStates = []
    this.layerStatesSource = null
    this.layerStatesSignature = ''
    this.lastFrameIndex = -1
    this.lastLayersHash = ''
    this.lastSlotSignature = ''
    this.activeSpriteIndices = []
    this.nextActiveSpriteIndices = []
    this.visibleSpriteMarks = new Uint32Array(0)
    this.visibilityGeneration = 0
    this.renderedSpriteCount = 0
    this.cacheHits = 0
    this.cacheMisses = 0
  }

  private buildSpriteNodes(): void {
    const sprites = this.videoItem?.movie.sprites || []
    this.stage.removeChildren()
    this.spriteNodes = new Array(sprites.length)
    this.visibleSpriteMarks = new Uint32Array(sprites.length)
    this.activeSpriteIndices = []
    this.nextActiveSpriteIndices = []

    for (let spriteIndex = 0; spriteIndex < sprites.length; spriteIndex++) {
      const container = new Container()
      const sprite = new Sprite(Texture.EMPTY)
      const maskContainer = new Container()
      const maskSprite = new Sprite(Texture.EMPTY)

      container.visible = false
      container.eventMode = 'none'
      sprite.anchor.set(0, 0)
      sprite.eventMode = 'none'
      container.addChild(sprite)
      maskContainer.visible = false
      maskContainer.eventMode = 'none'
      maskSprite.anchor.set(0, 0)
      maskSprite.eventMode = 'none'
      maskContainer.addChild(maskSprite)
      this.stage.addChild(container)
      this.stage.addChild(maskContainer)

      this.spriteNodes[spriteIndex] = {
        container,
        sprite,
        matrix: new Matrix(),
        maskContainer,
        maskSprite,
        maskMatrix: new Matrix(),
        maskTexture: null,
        maskWidth: -1,
        maskHeight: -1,
        texture: null,
        width: -1,
        height: -1,
        blendMode: 'normal'
      }
    }
  }

  private nextVisibilityGeneration(): number {
    this.visibilityGeneration += 1
    if (this.visibilityGeneration >= 0xffffffff) {
      this.visibleSpriteMarks.fill(0)
      this.visibilityGeneration = 1
    }
    return this.visibilityGeneration
  }

  private precomputeDisplayLists(): void {
    if (!this.videoItem?.movie.params) return

    const { sprites, params } = this.videoItem.movie
    this.displayLists = new Array(params.frames)

    for (let frameIndex = 0; frameIndex < params.frames; frameIndex++) {
      const items: FrameDisplayItem[] = []

      for (let spriteIndex = 0; spriteIndex < sprites.length; spriteIndex++) {
        const sprite = sprites[spriteIndex]
        const frame = sprite.frames?.[frameIndex]
        if (!frame) continue

        const alpha = frame.alpha ?? 1
        if (alpha <= 0) continue

        const layout = frame.layout
        if (!layout || layout.width <= 0 || layout.height <= 0) continue

        items.push({
          spriteIndex,
          imageKey: sprite.imageKey,
          matteKey: sprite.matteKey || undefined,
          transform: this.getFrameTransform(frame),
          width: layout.width,
          height: layout.height,
          alpha,
          blendMode: this.normalizeBlendMode(frame.blendMode)
        })
      }

      this.displayLists[frameIndex] = items
    }
  }

  private getFrameItemsByImageKey(frameItems: FrameDisplayItem[]): Map<string, FrameDisplayItem> {
    const map = new Map<string, FrameDisplayItem>()
    for (const item of frameItems) {
      if (!map.has(item.imageKey)) map.set(item.imageKey, item)
    }
    return map
  }

  private updateMaskNode(node: SpriteNode, matteItem: FrameDisplayItem): boolean {
    const texture = this.slotTextures.get(matteItem.imageKey) || this.textureCache.get(matteItem.imageKey)
    if (!texture || texture === Texture.EMPTY) return false

    if (node.maskTexture !== texture) {
      node.maskSprite.texture = texture
      node.maskTexture = texture
      node.maskWidth = -1
      node.maskHeight = -1
    }
    if (node.maskWidth !== matteItem.width) {
      node.maskSprite.width = matteItem.width
      node.maskWidth = matteItem.width
    }
    if (node.maskHeight !== matteItem.height) {
      node.maskSprite.height = matteItem.height
      node.maskHeight = matteItem.height
    }

    node.maskMatrix.a = matteItem.transform.a
    node.maskMatrix.b = matteItem.transform.b
    node.maskMatrix.c = matteItem.transform.c
    node.maskMatrix.d = matteItem.transform.d
    node.maskMatrix.tx = matteItem.transform.tx
    node.maskMatrix.ty = matteItem.transform.ty
    node.maskContainer.setFromMatrix(node.maskMatrix)
    node.maskContainer.alpha = matteItem.alpha
    node.maskContainer.visible = true
    node.container.mask = node.maskContainer
    return true
  }

  private getFrameTransform(frame: FrameData): PixiTransform {
    const layout = frame.layout
    const transform = frame.transform
    return {
      a: transform?.a ?? 1,
      b: transform?.b ?? 0,
      c: transform?.c ?? 0,
      d: transform?.d ?? 1,
      tx: transform?.tx ?? layout?.x ?? 0,
      ty: transform?.ty ?? layout?.y ?? 0
    }
  }

  private getLayerSpriteIndex(layer: Layer, index: number): number {
    if (typeof layer.editableIndex === 'number' && Number.isFinite(layer.editableIndex)) {
      return layer.editableIndex
    }

    const numericId = Number(layer.id)
    return Number.isFinite(numericId) ? numericId : index
  }

  private getLayerStates(layers: Layer[]): Array<LayerRenderState | undefined> {
    if (this.layerStatesSource === layers) return this.layerStates

    let signature = ''
    for (let index = 0; index < layers.length; index++) {
      const layer = layers[index]
      signature += `${this.getLayerSpriteIndex(layer, index)}:${layer.visible === false ? 0 : 1}:${layer.opacity ?? 1}|`
    }

    if (signature !== this.layerStatesSignature) {
      const nextStates: Array<LayerRenderState | undefined> = []
      for (let index = 0; index < layers.length; index++) {
        const layer = layers[index]
        nextStates[this.getLayerSpriteIndex(layer, index)] = {
          visible: layer.visible !== false,
          opacity: layer.opacity ?? 1
        }
      }
      this.layerStates = nextStates
      this.layerStatesSignature = signature
    }

    this.layerStatesSource = layers
    return this.layerStates
  }

  private getLayersHash(layers: Layer[]): string {
    let hash = ''
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i]
      hash += `${this.getLayerSpriteIndex(layer, i)}:${layer.visible === false ? 0 : 1}:${layer.opacity ?? 1}|`
    }
    return hash
  }

  private getSlotSignature(slotConfigs: Record<string, SlotConfig>, applySlots: boolean): string {
    if (!applySlots) return ''
    return Object.entries(slotConfigs)
      .map(([key, slot]) => `${key}:${slot.type}:${slot.imageConfig?.url ?? ''}`)
      .sort()
      .join('|')
  }

  private prepareSlotTextures(slotConfigs: Record<string, SlotConfig>, applySlots: boolean): void {
    if (!applySlots) return

    for (const [key, slot] of Object.entries(slotConfigs)) {
      if (slot.type !== 'image' || !slot.imageConfig?.url) continue

      const url = slot.imageConfig.url
      if (this.slotTextureUrls.get(key) === url || this.pendingSlotTextureUrls.get(key) === url) {
        continue
      }

      this.pendingSlotTextureUrls.set(key, url)
      Assets.load<Texture>(url)
        .then((texture) => {
          if (this.pendingSlotTextureUrls.get(key) !== url) return
          this.pendingSlotTextureUrls.delete(key)
          this.slotTextureUrls.set(key, url)
          this.slotTextures.set(key, texture)
          this.lastSlotSignature = ''
          this.renderFrame(this._currentFrame, { slotConfigs, applySlots })
        })
        .catch((err) => {
          if (this.pendingSlotTextureUrls.get(key) === url) {
            this.pendingSlotTextureUrls.delete(key)
          }
          console.warn(`[PixiRenderer] Failed to load slot texture: ${key}`, err)
        })
    }
  }

  private renderNewLayers(layers: Layer[], frameIndex: number): void {
    for (const layer of layers) {
      if (!layer.isNew || !layer.visible || !layer.imageKey) continue
      const texture = this.newImageCache.get(layer.imageKey) || this.textureCache.get(layer.imageKey)
      if (!texture) continue

      const { startFrame, duration } = layer.clip
      if (frameIndex < startFrame || frameIndex >= startFrame + duration) continue

      const node = this.getOrCreateNewLayerNode(layer)
      if (!node) continue

      const props = AnimationEngine.getLayerPropertiesAtFrame(layer, frameIndex)
      const alpha = props.alpha * (layer.opacity ?? 1)
      if (alpha <= 0) continue

      node.sprite.texture = texture
      node.sprite.width = texture.width
      node.sprite.height = texture.height
      node.container.position.set(props.position.x, props.position.y)
      node.container.scale.set(props.scale.scaleX, props.scale.scaleY)
      node.container.rotation = (props.rotation * Math.PI) / 180
      node.container.alpha = alpha
      node.container.visible = true
    }
  }

  private getOrCreateNewLayerNode(layer: Layer): SpriteNode | null {
    const spriteIndex = this.spriteNodes.length
    const existing = this.stage.getChildByName(layer.id) as Container | null
    if (existing) {
      const sprite = existing.children[0] as Sprite | undefined
      if (sprite) {
        const maskContainer = new Container()
        const maskSprite = new Sprite(Texture.EMPTY)
        maskContainer.visible = false
        maskContainer.eventMode = 'none'
        maskSprite.eventMode = 'none'
        maskContainer.addChild(maskSprite)
        this.stage.addChild(maskContainer)
        return {
          container: existing,
          sprite,
          matrix: new Matrix(),
          maskContainer,
          maskSprite,
          maskMatrix: new Matrix(),
          maskTexture: null,
          maskWidth: -1,
          maskHeight: -1,
          texture: sprite.texture,
          width: sprite.width,
          height: sprite.height,
          blendMode: sprite.blendMode
        }
      }
    }

    const container = new Container()
    const sprite = new Sprite(Texture.EMPTY)
    const maskContainer = new Container()
    const maskSprite = new Sprite(Texture.EMPTY)
    container.name = layer.id
    container.eventMode = 'none'
    sprite.eventMode = 'none'
    container.addChild(sprite)
    maskContainer.visible = false
    maskContainer.eventMode = 'none'
    maskSprite.eventMode = 'none'
    maskContainer.addChild(maskSprite)
    this.stage.addChild(container)
    this.stage.addChild(maskContainer)
    const node = {
      container,
      sprite,
      matrix: new Matrix(),
      maskContainer,
      maskSprite,
      maskMatrix: new Matrix(),
      maskTexture: null,
      maskWidth: -1,
      maskHeight: -1,
      texture: null,
      width: -1,
      height: -1,
      blendMode: 'normal' as BLEND_MODES
    }
    this.spriteNodes[spriteIndex] = node
    return node
  }

  private normalizeBlendMode(blendMode?: string): BLEND_MODES {
    const map: Record<string, BLEND_MODES> = {
      normal: 'normal',
      multiply: 'multiply',
      screen: 'screen',
      darken: 'darken',
      lighten: 'lighten',
      add: 'add',
      overlay: 'normal',
      'color-dodge': 'normal',
      'color-burn': 'normal',
      'hard-light': 'normal',
      'soft-light': 'normal',
      difference: 'normal',
      exclusion: 'normal'
    }
    return map[(blendMode || 'normal').toLowerCase()] || 'normal'
  }

  private recordFps(): void {
    const now = performance.now()
    this.renderCount++

    if (this.lastFpsUpdate === 0) {
      this.lastFpsUpdate = now
      return
    }

    const elapsed = now - this.lastFpsUpdate
    if (elapsed >= 1000) {
      this.fps = Math.round(this.renderCount * 1000 / elapsed)
      this.renderCount = 0
      this.lastFpsUpdate = now
    }
  }
}
