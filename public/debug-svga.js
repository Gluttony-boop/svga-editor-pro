// Debug script for SVGA renderer
window.debugSVGA = function() {
  const results = [];
  
  const canvas = document.querySelector('canvas');
  if (!canvas) {
    results.push('ERROR: Canvas not found');
    return results;
  }
  
  results.push(`Canvas: ${canvas.width}x${canvas.height}`);
  
  const ctx = canvas.getContext('2d');
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let nonZero = 0;
  for (let i = 3; i < data.data.length; i += 4) {
    if (data.data[i] > 0) nonZero++;
  }
  results.push(`Canvas content: ${nonZero}/${data.data.length/4} non-zero pixels`);
  
  const renderer = window.__SVGA_RENDERER__ || canvas.__renderer;
  if (renderer) {
    results.push('=== RENDERER STATE ===');
    results.push(`hasVideoData: ${renderer.hasVideoData()}`);
    results.push(`videoItem: ${renderer.videoItem !== null}`);
    results.push(`params: ${renderer.params !== null}`);
    
    if (renderer.params) {
      results.push(`  viewBoxWidth: ${renderer.params.viewBoxWidth}`);
      results.push(`  viewBoxHeight: ${renderer.params.viewBoxHeight}`);
      results.push(`  fps: ${renderer.params.fps}`);
      results.push(`  frames: ${renderer.params.frames}`);
    }
    
    results.push(`imageCache.size: ${renderer.imageCache?.size || 0}`);
    results.push(`frameCache.size: ${renderer.frameCache?.size || 0}`);
    results.push(`precomputedFrames.size: ${renderer.precomputedFrames?.size || 0}`);
    
    if (renderer.imageCache && renderer.imageCache.size > 0) {
      const keys = Array.from(renderer.imageCache.keys());
      results.push(`Image cache keys (first 5): ${keys.slice(0, 5).join(', ')}`);
      
      const firstKey = keys[0];
      const firstImg = renderer.imageCache.get(firstKey);
      if (firstImg) {
        results.push(`First image: ${firstKey}, size: ${firstImg.width}x${firstImg.height}, complete: ${firstImg.complete}`);
      }
    }
    
    if (renderer.precomputedFrames && renderer.precomputedFrames.size > 0) {
      const frame0 = renderer.precomputedFrames.get(0);
      results.push(`Frame 0 sprites: ${frame0 ? frame0.length : 0}`);
      
      if (frame0 && frame0.length > 0) {
        const sprite0 = frame0[0];
        results.push(`Frame 0 first sprite: ${sprite0.imageKey}, alpha: ${sprite0.finalAlpha}, layout: ${sprite0.frame.layout?.width}x${sprite0.frame.layout?.height}`);
      }
    }
  } else {
    results.push('ERROR: Renderer not found!');
  }
  
  return results;
};

window.debugFrame0 = function() {
  const r = window.__SVGA_RENDERER__;
  if (!r) return 'Renderer not found';
  
  const results = [];
  const frame0 = r.precomputedFrames.get(0);
  
  if (!frame0 || frame0.length === 0) {
    return 'No sprites in frame 0';
  }
  
  frame0.forEach((s, i) => {
    const img = r.imageCache.get(s.imageKey);
    results.push(`Sprite ${i}: ${s.imageKey}`);
    results.push(`  alpha: ${s.finalAlpha}`);
    results.push(`  layout: ${s.frame.layout?.width}x${s.frame.layout?.height}`);
    results.push(`  transform: a=${s.frame.transform?.a} b=${s.frame.transform?.b} c=${s.frame.transform?.c} d=${s.frame.transform?.d} tx=${s.frame.transform?.tx} ty=${s.frame.transform?.ty}`);
    results.push(`  img in cache: ${!!img}`);
    if (img) {
      results.push(`  img size: ${img.width}x${img.height}, complete: ${img.complete}`);
    }
  });
  
  return results;
};

window.testRenderFrame0 = function() {
  const r = window.__SVGA_RENDERER__;
  if (!r) return 'Renderer not found';
  
  const canvas = document.querySelector('canvas');
  const ctx = canvas.getContext('2d');
  
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  
  r.renderFrame(0, { layers: [], slotConfigs: {} });
  
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let nonZero = 0;
  for (let i = 3; i < data.data.length; i += 4) {
    if (data.data[i] > 0) nonZero++;
  }
  
  return `After rendering frame 0: ${nonZero} non-zero pixels out of ${data.data.length/4}`;
};

window.checkAnimation = function() {
  const r = window.__SVGA_RENDERER__;
  if (!r) return 'Renderer not found';
  
  const results = [];
  const sprite = r.videoItem.movie.sprites[0];
  
  for (let i = 0; i < Math.min(10, sprite.frames.length); i++) {
    const f = sprite.frames[i];
    results.push(`Frame ${i}: tx=${f.transform?.tx}, ty=${f.transform?.ty}`);
  }
  
  return results;
};

window.manualDraw = function() {
  const r = window.__SVGA_RENDERER__;
  if (!r) return 'Renderer not found';
  
  const canvas = document.querySelector('canvas');
  const ctx = canvas.getContext('2d');
  
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  
  const frame0 = r.precomputedFrames.get(0);
  if (!frame0 || frame0.length === 0) return 'No sprites in frame 0';
  
  const results = [];
  
  frame0.forEach((s, idx) => {
    const img = r.imageCache.get(s.imageKey);
    if (!img) {
      results.push(`Sprite ${idx}: image not in cache`);
      return;
    }
    
    ctx.save();
    ctx.globalAlpha = s.finalAlpha;
    
    const t = s.frame.transform;
    if (t) {
      ctx.setTransform(
        t.a ?? 1,
        t.b ?? 0,
        t.c ?? 0,
        t.d ?? 1,
        t.tx ?? 0,
        t.ty ?? 0
      );
    }
    
    const layout = s.frame.layout;
    ctx.drawImage(img, 0, 0, layout.width, layout.height);
    
    results.push(`Sprite ${idx} (${s.imageKey}): drew at tx=${t?.tx}, ty=${t?.ty}`);
    
    ctx.restore();
  });
  
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let nonZero = 0;
  for (let i = 3; i < data.data.length; i += 4) {
    if (data.data[i] > 0) nonZero++;
  }
  
  results.push(`Result: ${nonZero} non-zero pixels`);
  
  return results;
};

window.checkLayout = function() {
  const r = window.__SVGA_RENDERER__;
  if (!r) return 'Renderer not found';
  
  const results = [];
  const sprite = r.videoItem.movie.sprites[0];
  const frame = sprite.frames[0];
  
  results.push('Frame 0 layout:');
  results.push('  ' + JSON.stringify(frame.layout));
  results.push('Frame 0 transform:');
  results.push('  ' + JSON.stringify(frame.transform));
  results.push('Layout has x: ' + ('x' in (frame.layout || {})));
  results.push('Layout has y: ' + ('y' in (frame.layout || {})));
  
  // Check all sprites
  results.push('\\nAll sprites:');
  r.videoItem.movie.sprites.forEach((s, i) => {
    const f = s.frames[0];
    if (f && f.layout) {
      results.push(`  Sprite ${i} (${s.imageKey}): layout.x=${f.layout.x}, layout.y=${f.layout.y}, tx=${f.transform?.tx}, ty=${f.transform?.ty}`);
    }
  });
  
  return results;
};

console.log('Debug script loaded. Commands: debugSVGA(), debugFrame0(), testRenderFrame0(), checkAnimation(), manualDraw(), checkLayout()');

window.checkCache = function() {
  const r = window.__SVGA_RENDERER__;
  if (!r) return 'Renderer not found';
  
  const results = [];
  const cache = r.frameCache.get(0);
  
  if (!cache) {
    results.push('No cache for frame 0');
    return results;
  }
  
  const ctx = cache.canvas.getContext('2d');
  const data = ctx.getImageData(0, 0, cache.canvas.width, cache.canvas.height);
  
  let nonZero = 0;
  for (let i = 3; i < data.data.length; i += 4) {
    if (data.data[i] > 0) nonZero++;
  }
  
  results.push(`Cache 0: ${cache.canvas.width}x${cache.canvas.height}`);
  results.push(`Cache 0 has ${nonZero} non-zero pixels`);
  results.push(`Cache type: ${cache.canvas.constructor.name}`);
  
  return results;
};

window.clearCacheAndRender = function() {
  const r = window.__SVGA_RENDERER__;
  if (!r) return 'Renderer not found';
  
  r.clearFrameCache();
  r.renderFrame(0, { layers: [], slotConfigs: {} });
  
  const canvas = document.querySelector('canvas');
  const ctx = canvas.getContext('2d');
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  
  let nonZero = 0;
  for (let i = 3; i < data.data.length; i += 4) {
    if (data.data[i] > 0) nonZero++;
  }
  
  return `After clearing cache and rendering frame 0: ${nonZero} non-zero pixels`;
};

window.renderFrame = function(frameIndex) {
  const r = window.__SVGA_RENDERER__;
  if (!r) return 'Renderer not found';
  
  r.clearFrameCache();
  r.renderFrame(frameIndex, { layers: [], slotConfigs: {} });
  
  const canvas = document.querySelector('canvas');
  const ctx = canvas.getContext('2d');
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  
  let nonZero = 0;
  for (let i = 3; i < data.data.length; i += 4) {
    if (data.data[i] > 0) nonZero++;
  }
  
  return `Frame ${frameIndex}: ${nonZero} non-zero pixels`;
};

window.checkAllCaches = function() {
  const r = window.__SVGA_RENDERER__;
  if (!r) return 'Renderer not found';
  
  const results = [];
  
  for (let i = 0; i < 10; i++) {
    const cache = r.frameCache.get(i);
    if (!cache) {
      results.push(`Frame ${i}: no cache`);
      continue;
    }
    
    const ctx = cache.canvas.getContext('2d');
    const data = ctx.getImageData(0, 0, cache.canvas.width, cache.canvas.height);
    
    let nonZero = 0;
    for (let j = 3; j < data.data.length; j += 4) {
      if (data.data[j] > 0) nonZero++;
    }
    
    results.push(`Frame ${i}: ${nonZero} non-zero pixels`);
  }
  
  return results;
};

window.forceRenderFrame = function(frameIndex) {
  const r = window.__SVGA_RENDERER__;
  if (!r) return 'Renderer not found';
  
  // 临时禁用缓存
  const wasEnabled = r.cacheEnabled;
  r.cacheEnabled = false;
  
  r.renderFrame(frameIndex, { layers: [], slotConfigs: {} });
  
  // 恢复缓存设置
  r.cacheEnabled = wasEnabled;
  
  const canvas = document.querySelector('canvas');
  const ctx = canvas.getContext('2d');
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  
  let nonZero = 0;
  for (let i = 3; i < data.data.length; i += 4) {
    if (data.data[i] > 0) nonZero++;
  }
  
  return `Force render frame ${frameIndex}: ${nonZero} non-zero pixels`;
};

window.testPreRender = function() {
  const r = window.__SVGA_RENDERER__;
  if (!r) return 'Renderer not found';
  
  const results = [];
  
  // 手动渲染帧 5 并检查
  results.push('=== Testing manual render of frame 5 ===');
  
  // 临时禁用缓存
  r.cacheEnabled = false;
  r.renderFrame(5, { layers: [], slotConfigs: {} });
  r.cacheEnabled = true;
  
  // 检查主画布
  const canvas = document.querySelector('canvas');
  const ctx = canvas.getContext('2d');
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let canvasNonZero = 0;
  for (let i = 3; i < data.data.length; i += 4) {
    if (data.data[i] > 0) canvasNonZero++;
  }
  results.push(`Canvas after render: ${canvasNonZero} non-zero pixels`);
  
  // 手动缓存
  r.cacheFrame(5);
  
  // 检查缓存
  const cache = r.frameCache.get(5);
  if (cache) {
    const cacheCtx = cache.canvas.getContext('2d');
    const cacheData = cacheCtx.getImageData(0, 0, cache.canvas.width, cache.canvas.height);
    let cacheNonZero = 0;
    for (let i = 3; i < cacheData.data.length; i += 4) {
      if (cacheData.data[i] > 0) cacheNonZero++;
    }
    results.push(`Cache after manual cacheFrame: ${cacheNonZero} non-zero pixels`);
  } else {
    results.push('Cache not found after cacheFrame');
  }
  
  return results;
};

window.checkPrecomputed = function() {
  const r = window.__SVGA_RENDERER__;
  if (!r) return 'Renderer not found';
  
  const results = [];
  results.push('precomputedFrames.size: ' + r.precomputedFrames.size);
  
  for (let i = 0; i < 5; i++) {
    const f = r.precomputedFrames.get(i);
    if (!f) {
      results.push('Frame ' + i + ': undefined');
      continue;
    }
    results.push('Frame ' + i + ': ' + f.length + ' sprites');
    f.forEach((s, j) => {
      results.push('  Sprite ' + j + ': ' + s.imageKey);
      results.push('    transform: ' + JSON.stringify(s.frame.transform));
      results.push('    layout: ' + s.frame.layout.width + 'x' + s.frame.layout.height);
    });
  }
  
  return results;
};

window.manualRenderTest = function(frameIndex) {
  const r = window.__SVGA_RENDERER__;
  if (!r) return 'Renderer not found';
  
  const canvas = document.querySelector('canvas');
  const ctx = canvas.getContext('2d');
  
  // 清空画布
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  
  const frameSprites = r.precomputedFrames.get(frameIndex);
  if (!frameSprites) return 'No sprites for frame ' + frameIndex;
  
  const results = [];
  results.push('Rendering frame ' + frameIndex + ' with ' + frameSprites.length + ' sprites');
  
  frameSprites.forEach((s, i) => {
    const img = r.imageCache.get(s.imageKey);
    if (!img) {
      results.push('Sprite ' + i + ': image not found');
      return;
    }
    
    const t = s.frame.transform;
    const layout = s.frame.layout;
    
    results.push('Sprite ' + i + ' (' + s.imageKey + '):');
    results.push('  Image: ' + img.width + 'x' + img.height);
    results.push('  Layout: ' + layout.width + 'x' + layout.height);
    results.push('  Transform: a=' + t.a + ', tx=' + t.tx + ', ty=' + t.ty);
    
    // 计算绘制范围
    const x1 = t.tx;
    const x2 = t.tx + layout.width * (t.a || 1);
    const y1 = t.ty;
    const y2 = t.ty + layout.height * (t.d || 1);
    results.push('  Draw range: x=[' + x1 + ', ' + x2 + '], y=[' + y1 + ', ' + y2 + ']');
    results.push('  Canvas visible: ' + (x2 > 0 && x1 < canvas.width && y2 > 0 && y1 < canvas.height));
    
    // 手动渲染
    ctx.save();
    ctx.globalAlpha = s.finalAlpha;
    ctx.setTransform(
      t.a ?? 1,
      t.b ?? 0,
      t.c ?? 0,
      t.d ?? 1,
      t.tx ?? 0,
      t.ty ?? 0
    );
    ctx.drawImage(img, 0, 0, layout.width, layout.height);
    ctx.restore();
  });
  
  // 检查渲染结果
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let nonZero = 0;
  for (let i = 3; i < data.data.length; i += 4) {
    if (data.data[i] > 0) nonZero++;
  }
  results.push('Result: ' + nonZero + ' non-zero pixels');
  
  return results;
};

window.debugLayout = function() {
  const r = window.__SVGA_RENDERER__;
  if (!r) return 'Renderer not found';
  
  const results = [];
  const sprite = r.videoItem.movie.sprites[0];
  const frame = sprite.frames[0];
  
  results.push('Layout info:');
  results.push(JSON.stringify(frame.layout, null, 2));
  results.push('Layout keys: ' + Object.keys(frame.layout || {}).join(', '));
  results.push('Layout has x: ' + ('x' in (frame.layout || {})));
  results.push('Layout has y: ' + ('y' in (frame.layout || {})));
  
  return results;
};
