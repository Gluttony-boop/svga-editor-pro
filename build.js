const JavaScriptObfuscator = require('javascript-obfuscator');
const fs = require('fs');
const path = require('path');

// 确保dist目录存在
if (!fs.existsSync('dist')) {
    fs.mkdirSync('dist', { recursive: true });
}

// 复制assets目录
function copyDir(src, dest) {
    if (!fs.existsSync(dest)) {
        fs.mkdirSync(dest, { recursive: true });
    }
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            copyDir(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

// 复制assets
if (fs.existsSync('assets')) {
    copyDir('assets', 'dist/assets');
    console.log('✓ Assets copied');
}

// 读取并处理HTML
let html = fs.readFileSync('index.html', 'utf8');

// 提取所有内联script标签并混淆
html = html.replace(/<script>([\s\S]*?)<\/script>/gi, (match, code) => {
    try {
        const obfuscatedCode = JavaScriptObfuscator.obfuscate(code, {
            compact: true,
            controlFlowFlattening: true,
            controlFlowFlatteningThreshold: 0.75,
            deadCodeInjection: true,
            deadCodeInjectionThreshold: 0.4,
            debugProtection: true,
            debugProtectionInterval: 2000,
            disableConsoleOutput: true,
            identifierNamesGenerator: 'hexadecimal',
            log: false,
            numbersToExpressions: true,
            renameGlobals: false,
            selfDefending: true,
            simplify: true,
            splitStrings: true,
            splitStringsChunkLength: 10,
            stringArray: true,
            stringArrayCallsTransform: true,
            stringArrayEncoding: ['rc4'],
            stringArrayIndexShift: true,
            stringArrayRotate: true,
            stringArrayShuffle: true,
            stringArrayWrappersCount: 2,
            stringArrayWrappersChainedCalls: true,
            stringArrayWrappersParametersMaxCount: 4,
            stringArrayWrappersType: 'function',
            stringArrayThreshold: 0.75,
            transformObjectKeys: true,
            unicodeEscapeSequence: false
        });
        return `<script>${obfuscatedCode.getObfuscatedCode()}</script>`;
    } catch (e) {
        console.warn('Warning: Failed to obfuscate script block:', e.message);
        return match;
    }
});

// 禁用右键菜单和开发者工具快捷键
const securityScript = `
<script>
// 禁用右键菜单
document.addEventListener('contextmenu', e => e.preventDefault());
// 禁用F12和开发者工具快捷键
document.addEventListener('keydown', e => {
    if (e.key === 'F12' || 
        (e.ctrlKey && e.shiftKey && (e.key === 'I' || e.key === 'J' || e.key === 'C')) ||
        (e.ctrlKey && e.key === 'U')) {
        e.preventDefault();
    }
});
</script>
`;

// 在</head>前插入安全脚本
html = html.replace('</head>', securityScript + '</head>');

// 写入dist目录
fs.writeFileSync('dist/index.html', html);
console.log('✓ HTML processed and obfuscated');

console.log('\n✅ Build preparation complete!');
console.log('Next step: Run "npm run build" to create the application.');
