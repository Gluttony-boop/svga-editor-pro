import type { Layer } from '@/types'

type ImageMapValue = Uint8Array | number[] | ArrayBuffer
type MutableImageMap = Record<string, ImageMapValue>

interface MutableSpriteLike {
  imageKey?: string | null
  matteKey?: string | null
}

interface MutableMovieLike {
  images?: MutableImageMap | null
  sprites?: MutableSpriteLike[] | null
}

const hasOwn = (target: MutableImageMap, key: string) =>
  Object.prototype.hasOwnProperty.call(target, key)

export function getLayerExportImageKey(layer: Layer, fallback = ''): string {
  const trimmedName = layer.name.trim()
  if (trimmedName) return trimmedName
  return layer.imageKey || fallback || layer.id
}

export function findLayerForSpriteIndex(
  layers: Layer[] | undefined,
  spriteIndex: number
): Layer | undefined {
  if (!layers?.length) return undefined

  return layers.find((layer) => layer.editableIndex === spriteIndex) ??
    layers.find((layer) => layer.id === String(spriteIndex)) ??
    layers[spriteIndex]
}

function allocateImageKey(
  requestedKey: string,
  sourceKey: string,
  images: MutableImageMap,
  claimedKeys: Map<string, string>,
  layerIndex: number
): string {
  const requestedClaim = claimedKeys.get(requestedKey)
  const requestedIsAvailable =
    requestedClaim === sourceKey ||
    (
      requestedClaim === undefined &&
      (!hasOwn(images, requestedKey) || requestedKey === sourceKey)
    )

  if (requestedIsAvailable) return requestedKey

  let suffix = layerIndex + 1
  let candidate = `${requestedKey}_${suffix}`
  while (true) {
    const candidateClaim = claimedKeys.get(candidate)
    const candidateIsAvailable =
      candidateClaim === sourceKey ||
      (
        candidateClaim === undefined &&
        (!hasOwn(images, candidate) || candidate === sourceKey)
      )

    if (candidateIsAvailable) return candidate

    suffix += 1
    candidate = `${requestedKey}_${suffix}`
  }
}

export function createLayerImageAliases(
  images: MutableImageMap,
  layers: Layer[],
  sourceKeyByLayerId: Map<string, string> = new Map()
): Map<string, string> {
  const aliases = new Map<string, string>()
  const claimedKeys = new Map<string, string>()

  layers.forEach((layer, index) => {
    if (layer.type !== 'image') return

    const sourceKey = sourceKeyByLayerId.get(layer.id) ?? layer.imageKey
    if (!sourceKey) return

    const requestedKey = getLayerExportImageKey(layer, sourceKey)
    if (!requestedKey) return

    const sourceImage = images[sourceKey]
    if (requestedKey !== sourceKey && sourceImage === undefined) {
      aliases.set(layer.id, sourceKey)
      claimedKeys.set(sourceKey, sourceKey)
      return
    }

    const exportKey = allocateImageKey(
      requestedKey,
      sourceKey,
      images,
      claimedKeys,
      index
    )

    aliases.set(layer.id, exportKey)
    claimedKeys.set(exportKey, sourceKey)

    if (exportKey !== sourceKey && sourceImage !== undefined && !hasOwn(images, exportKey)) {
      images[exportKey] = sourceImage
    }
  })

  return aliases
}

export function hasLayerNameChangesForSprites(
  sprites: MutableSpriteLike[] | undefined | null,
  layers: Layer[] | undefined
): boolean {
  if (!sprites?.length || !layers?.length) return false

  return sprites.some((sprite, index) => {
    const layer = findLayerForSpriteIndex(layers, index)
    if (!layer || layer.type !== 'image') return false

    const currentKey = sprite.imageKey || layer.imageKey || ''
    if (!currentKey) return false

    return getLayerExportImageKey(layer, currentKey) !== currentKey
  })
}

export function applyLayerNamesToMovie(
  movie: MutableMovieLike,
  layers: Layer[] | undefined
): boolean {
  const sprites = movie.sprites
  const images = movie.images
  if (!sprites?.length || !images || !layers?.length) return false

  const sourceKeyByLayerId = new Map<string, string>()
  sprites.forEach((sprite, index) => {
    const layer = findLayerForSpriteIndex(layers, index)
    // 优先使用解码后消息中的原始 key（未被 renameImageKey 修改），
    // 这样才能在 images map 中找到对应的图片数据
    const sourceKey = sprite.imageKey || layer?.imageKey || ''
    if (layer && sourceKey) {
      sourceKeyByLayerId.set(layer.id, sourceKey)
    }
  })

  const aliases = createLayerImageAliases(images, layers, sourceKeyByLayerId)
  const renamedSourceKeys = new Map<string, string>()
  let changed = false

  sprites.forEach((sprite, index) => {
    const layer = findLayerForSpriteIndex(layers, index)
    if (!layer) return

    const exportKey = aliases.get(layer.id)
    const currentKey = sprite.imageKey || ''
    if (!exportKey || !currentKey || exportKey === currentKey) return

    sprite.imageKey = exportKey
    renamedSourceKeys.set(sourceKeyByLayerId.get(layer.id) ?? currentKey, exportKey)
    changed = true
  })

  sprites.forEach((sprite) => {
    if (!sprite.matteKey) return

    const exportMatteKey = renamedSourceKeys.get(sprite.matteKey)
    if (exportMatteKey && exportMatteKey !== sprite.matteKey) {
      sprite.matteKey = exportMatteKey
      changed = true
    }
  })

  // 删除不再被任何 sprite/matteKey 引用的旧图片数据
  // 避免导出的 SVGA 中残留旧 key 导致出现重复精灵图
  if (renamedSourceKeys.size > 0) {
    const usedKeys = new Set<string>()
    sprites.forEach((sprite) => {
      if (sprite.imageKey) usedKeys.add(sprite.imageKey)
      if (sprite.matteKey) usedKeys.add(sprite.matteKey)
    })
    for (const oldKey of renamedSourceKeys.keys()) {
      if (!usedKeys.has(oldKey) && hasOwn(images, oldKey)) {
        delete images[oldKey]
        changed = true
      }
    }
  }

  return changed
}
