import type { Layer, VideoItem } from '@/types'
import { getOriginalLayerIndex } from './layer-transform'

/** 删除内容层后，未再被引用的遮罩可作为普通图层显示；不能继续按源文件隐藏它。 */
export function getActiveMatteKeys(video: VideoItem | null, layers?: readonly Layer[]): Set<string> {
  const sprites = video?.movie.sprites ?? []
  if (layers === undefined) return new Set(sprites.flatMap(sprite => sprite.matteKey ? [sprite.matteKey] : []))
  const result = new Set<string>()
  for (const layer of layers) {
    const index = getOriginalLayerIndex(layer)
    const key = (index !== null ? sprites[index]?.matteKey : undefined) ?? layer.sprites?.matteKey
    if (key) result.add(key)
  }
  return result
}
