fn main() {
    // 编译 Protobuf
    prost_build::Config::new()
        .compile_protos(
            &["proto/svga.proto"],
            &["proto/"],
        )
        .expect("Failed to compile protobuf");

    tauri_build::build()
}
