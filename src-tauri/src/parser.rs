/// SVGA 解析器
/// 支持 SVGA 1.0 和 2.0 格式
/// 
/// 文件格式:
///   bytes[0-3]: "SVGA" magic
///   byte[4]:    版本号 (0x01=无压缩, 0x02=zlib压缩)
///   bytes[5-7]: 保留 (0x00)
///   bytes[8..]: 压缩的 Protobuf 数据

use flate2::read::ZlibDecoder;
use prost::Message;
use serde::{Deserialize, Serialize};
use std::io::Read;
use base64::{Engine, engine::general_purpose::STANDARD as BASE64};

// 引入 protoc 生成的模块
pub mod svga_proto {
    include!(concat!(env!("OUT_DIR"), "/com.opensource.svga.rs"));
}

use svga_proto::{MovieEntity, SpriteEntity, FrameEntity, Layout, Transform, ShapeEntity};

// ==================== 前端传输结构 ====================

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SvgaData {
    pub version: String,
    pub params: SvgaParams,
    pub sprites: Vec<SvgaSprite>,
    /// 图片 key -> base64 编码的图片数据
    pub images: Vec<SvgaImage>,
    /// 图片 key -> MIME 类型
    pub image_mime_types: Vec<SvgaMimeType>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SvgaParams {
    pub view_box_width: f32,
    pub view_box_height: f32,
    pub fps: i32,
    pub frames: i32,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SvgaSprite {
    pub image_key: String,
    pub matte_key: String,
    pub frames: Vec<SvgaFrame>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SvgaFrame {
    pub alpha: f32,
    pub layout: Option<SvgaLayout>,
    pub transform: Option<SvgaTransform>,
    pub clip_path: String,
    pub shapes: Vec<SvgaShape>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SvgaLayout {
    pub x: Option<f32>,
    pub y: Option<f32>,
    pub width: Option<f32>,
    pub height: Option<f32>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SvgaTransform {
    pub a: Option<f32>,
    pub b: Option<f32>,
    pub c: Option<f32>,
    pub d: Option<f32>,
    pub tx: Option<f32>,
    pub ty: Option<f32>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SvgaShape {
    #[serde(rename = "type")]
    pub shape_type: i32,
    pub shape_d: Option<String>,
    pub rect: Option<SvgaRectArgs>,
    pub ellipse: Option<SvgaEllipseArgs>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SvgaRectArgs {
    pub x: Option<f32>,
    pub y: Option<f32>,
    pub width: Option<f32>,
    pub height: Option<f32>,
    pub corner_radius: Option<f32>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SvgaEllipseArgs {
    pub x: Option<f32>,
    pub y: Option<f32>,
    pub radius_x: Option<f32>,
    pub radius_y: Option<f32>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SvgaImage {
    pub key: String,
    /// base64 编码
    pub data: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SvgaMimeType {
    pub key: String,
    pub mime_type: String,
}

// ==================== 解析逻辑 ====================

/// 检测图片 MIME 类型（基于文件头 magic bytes）
fn detect_image_mime_type(data: &[u8]) -> String {
    if data.len() < 4 {
        return "image/png".to_string();
    }
    // PNG: 89 50 4E 47
    if data[0] == 0x89 && data[1] == 0x50 && data[2] == 0x4E && data[3] == 0x47 {
        return "image/png".to_string();
    }
    // JPEG: FF D8
    if data[0] == 0xFF && data[1] == 0xD8 {
        return "image/jpeg".to_string();
    }
    // WebP: RIFF....WEBP
    if data.len() >= 12 && data[0] == 0x52 && data[1] == 0x49 && data[2] == 0x46 && data[3] == 0x46
        && data[8] == 0x57 && data[9] == 0x45 && data[10] == 0x42 && data[11] == 0x50
    {
        return "image/webp".to_string();
    }
    // GIF: GIF
    if data[0] == 0x47 && data[1] == 0x49 && data[2] == 0x46 {
        return "image/gif".to_string();
    }
    "image/png".to_string()
}

/// 解压缩 SVGA 数据
fn decompress_svga(data: &[u8]) -> Result<Vec<u8>, String> {
    if data.len() < 8 {
        return Err("文件太小，不是有效的 SVGA 文件".to_string());
    }

    // 检查 SVGA 文件头
    let magic = &data[0..4];
    if magic == b"SVGA" {
        let version = data[4];
        let compressed_data = &data[8..];

        match version {
            0x01 => {
                // 无压缩
                Ok(compressed_data.to_vec())
            }
            0x02 => {
                // zlib 压缩
                let mut decoder = ZlibDecoder::new(compressed_data);
                let mut decompressed = Vec::new();
                decoder.read_to_end(&mut decompressed)
                    .map_err(|e| format!("zlib 解压失败: {}", e))?;
                Ok(decompressed)
            }
            _ => Err(format!("不支持的 SVGA 版本: {}", version))
        }
    } else {
        // 无文件头，尝试直接解压
        let mut decoder = ZlibDecoder::new(data);
        let mut decompressed = Vec::new();
        match decoder.read_to_end(&mut decompressed) {
            Ok(_) => Ok(decompressed),
            Err(_) => {
                // 解压失败，返回原始数据（可能是未压缩的 protobuf）
                Ok(data.to_vec())
            }
        }
    }
}

/// 将 Protobuf Layout 转换为前端传输结构
/// 关键：保留 undefined 值（Option<T>），不填充默认值 0
fn convert_layout(layout: &Layout) -> SvgaLayout {
    // Layout 的字段都有默认值 0.0，但原始文件中可能不存在
    // 这里简单转换，前端需要根据 proto 语义处理
    // 注意：protobuf3 所有字段都有默认值，无法区分"未设置"和"值为0"
    // 但 SVGA 播放器的逻辑是：0 值也视为有效值
    SvgaLayout {
        x: Some(layout.x),
        y: Some(layout.y),
        width: Some(layout.width),
        height: Some(layout.height),
    }
}

/// 将 Protobuf Transform 转换为前端传输结构
fn convert_transform(transform: &Transform) -> SvgaTransform {
    // 检查是否为默认值（全零或单位矩阵）
    // 单位矩阵: a=1, b=0, c=0, d=1, tx=0, ty=0
    let is_identity = transform.a == 1.0 && transform.b == 0.0 
        && transform.c == 0.0 && transform.d == 1.0 
        && transform.tx == 0.0 && transform.ty == 0.0;
    
    if is_identity {
        // 单位矩阵也传输，前端需要完整数据
        SvgaTransform {
            a: Some(1.0),
            b: Some(0.0),
            c: Some(0.0),
            d: Some(1.0),
            tx: Some(0.0),
            ty: Some(0.0),
        }
    } else {
        SvgaTransform {
            a: Some(transform.a),
            b: Some(transform.b),
            c: Some(transform.c),
            d: Some(transform.d),
            tx: Some(transform.tx),
            ty: Some(transform.ty),
        }
    }
}

/// 将 Protobuf ShapeEntity 转换为前端传输结构
fn convert_shape(shape: &ShapeEntity) -> SvgaShape {
    // prost 生成的 oneof 字段是 args: Option<shape_entity::Args>
    let mut shape_d: Option<String> = None;
    let mut rect: Option<SvgaRectArgs> = None;
    let mut ellipse: Option<SvgaEllipseArgs> = None;

    if let Some(ref args) = shape.args {
        match args {
            svga_proto::shape_entity::Args::Shape(ref s) => {
                shape_d = Some(s.d.clone());
            }
            svga_proto::shape_entity::Args::Rect(ref r) => {
                rect = Some(SvgaRectArgs {
                    x: Some(r.x),
                    y: Some(r.y),
                    width: Some(r.width),
                    height: Some(r.height),
                    corner_radius: Some(r.corner_radius),
                });
            }
            svga_proto::shape_entity::Args::Ellipse(ref e) => {
                ellipse = Some(SvgaEllipseArgs {
                    x: Some(e.x),
                    y: Some(e.y),
                    radius_x: Some(e.radius_x),
                    radius_y: Some(e.radius_y),
                });
            }
        }
    }

    SvgaShape {
        shape_type: shape.r#type,
        shape_d,
        rect,
        ellipse,
    }
}

/// 将 Protobuf FrameEntity 转换为前端传输结构
fn convert_frame(frame: &FrameEntity) -> SvgaFrame {
    let layout = frame.layout.as_ref().map(|l| convert_layout(l));
    let transform = frame.transform.as_ref().map(|t| convert_transform(t));
    let shapes: Vec<SvgaShape> = frame.shapes.iter().map(|s| convert_shape(s)).collect();

    SvgaFrame {
        alpha: frame.alpha,
        layout,
        transform,
        clip_path: frame.clip_path.clone(),
        shapes,
    }
}

/// 将 Protobuf SpriteEntity 转换为前端传输结构
fn convert_sprite(sprite: &SpriteEntity) -> SvgaSprite {
    let frames: Vec<SvgaFrame> = sprite.frames.iter().map(|f| convert_frame(f)).collect();
    SvgaSprite {
        image_key: sprite.image_key.clone(),
        matte_key: sprite.matte_key.clone(),
        frames,
    }
}

/// 解析 SVGA 文件的二进制数据
pub fn parse_svga_data(buffer: &[u8]) -> Result<SvgaData, String> {
    // 1. 解压缩
    let decompressed = decompress_svga(buffer)?;

    // 2. Protobuf 解码
    let movie = MovieEntity::decode(decompressed.as_slice())
        .map_err(|e| format!("Protobuf 解码失败: {}", e))?;

    // 3. 提取图片资源（转为 base64）
    let mut images = Vec::new();
    let mut image_mime_types = Vec::new();
    for (key, data) in &movie.images {
        let mime_type = detect_image_mime_type(data);
        let b64 = BASE64.encode(data);
        images.push(SvgaImage { key: key.clone(), data: b64 });
        image_mime_types.push(SvgaMimeType { key: key.clone(), mime_type });
    }

    // 4. 转换参数
    let params = movie.params.as_ref()
        .map(|p| SvgaParams {
            view_box_width: p.view_box_width,
            view_box_height: p.view_box_height,
            fps: p.fps,
            frames: p.frames,
        })
        .unwrap_or(SvgaParams {
            view_box_width: 750.0,
            view_box_height: 1334.0,
            fps: 24,
            frames: 0,
        });

    // 5. 转换精灵
    let sprites: Vec<SvgaSprite> = movie.sprites.iter().map(|s| convert_sprite(s)).collect();

    Ok(SvgaData {
        version: movie.version.clone(),
        params,
        sprites,
        images,
        image_mime_types,
    })
}

/// 从文件路径解析 SVGA
pub fn parse_svga_file(path: &str) -> Result<SvgaData, String> {
    let buffer = std::fs::read(path)
        .map_err(|e| format!("读取文件失败: {}", e))?;
    parse_svga_data(&buffer)
}
