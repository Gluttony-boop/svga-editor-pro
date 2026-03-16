const { app, BrowserWindow, Menu, shell } = require('electron');
const path = require('path');

let mainWindow;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 900,
        minWidth: 1000,
        minHeight: 700,
        title: 'SVGA 编辑工具',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js'),
            webSecurity: true
        },

        // 防止用户打开开发者工具查看源码
        autoHideMenuBar: true
    });

    // 加载应用
    mainWindow.loadFile('dist/index.html');

    // 禁用开发者工具快捷键
    mainWindow.webContents.on('before-input-event', (event, input) => {
        if (input.key === 'F12' || 
            (input.control && input.shift && input.key === 'I') ||
            (input.control && input.shift && input.key === 'J') ||
            (input.control && input.shift && input.key === 'C') ||
            (input.control && input.key === 'U')) {
            event.preventDefault();
        }
    });

    // 禁止打开开发者工具
    mainWindow.webContents.on('devtools-opened', () => {
        mainWindow.webContents.closeDevTools();
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    // 创建菜单（可选）
    const template = [
        {
            label: '文件',
            submenu: [
                { role: 'quit', label: '退出' }
            ]
        },
        {
            label: '帮助',
            submenu: [
                {
                    label: '关于',
                    click: () => {
                        const { dialog } = require('electron');
                        dialog.showMessageBox(mainWindow, {
                            type: 'info',
                            title: '关于',
                            message: 'SVGA 编辑工具',
                            detail: '版本: 1.0.0\n作者: 郑任光\n专业的SVGA动画编辑工具'
                        });
                    }
                }
            ]
        }
    ];

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
}

// 禁止创建新的BrowserWindow
app.on('web-contents-created', (event, contents) => {
    contents.on('new-window', (event, navigationUrl) => {
        event.preventDefault();
        shell.openExternal(navigationUrl);
    });
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (mainWindow === null) {
        createWindow();
    }
});
