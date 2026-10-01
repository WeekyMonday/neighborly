const { app, BrowserWindow, desktopCapturer, dialog, session } = require('electron');
const { spawn } = require('child_process');
const http = require('http');

let backendProcess;
let mainWindow;
const backendPort = Number(process.env.PORT) || 3001;

function configureScreenCapturePicker() {
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        fetchWindowIcons: false
      });
      if (!sources.length || !mainWindow) {
        callback({});
        return;
      }

      const sourceLabels = sources.map((source, index) => {
        const kind = source.id.startsWith('screen:') ? 'Screen' : 'Window';
        return `${kind}: ${source.name || `Source ${index + 1}`}`;
      });
      const cancelIndex = sourceLabels.length;
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'question',
        title: 'Share your screen',
        message: 'Choose the screen or window you want to share.',
        buttons: [...sourceLabels, 'Cancel'],
        defaultId: 0,
        cancelId: cancelIndex,
        noLink: true
      });

      callback(response >= cancelIndex ? {} : { video: sources[response] });
    } catch (error) {
      console.error('Could not open the screen-share picker:', error);
      callback({});
    }
  });
}

function startBackend() {
  backendProcess = spawn(process.execPath, ['BACKEND/server.js'], {
    cwd: __dirname,
    stdio: 'inherit',
    env: {
      ...process.env,
      PORT: String(backendPort),
      ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {})
    }
  });

  backendProcess.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error('Backend exited with code', code);
    }
  });

  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 15000;
    let settled = false;

    const checkReady = () => {
      if (settled) return;
      const request = http.get(`http://127.0.0.1:${backendPort}/api`, (response) => {
        response.resume();
        if (response.statusCode === 200) {
          settled = true;
          resolve();
        } else {
          retry();
        }
      });

      request.on('error', retry);
      request.setTimeout(1000, () => request.destroy());
    };

    const retry = () => {
      if (settled) return;
      if (backendProcess.exitCode !== null || Date.now() >= deadline) {
        settled = true;
        reject(new Error(`Backend failed to start on port ${backendPort}`));
        return;
      }
      setTimeout(checkReady, 250);
    };

    backendProcess.once('error', (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    checkReady();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#f4f5f9',
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
      enableRemoteModule: true
    }
  });

  mainWindow.loadURL(`http://localhost:${backendPort}/login.html`);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  try {
    configureScreenCapturePicker();
    await startBackend();
    createWindow();
  } catch (error) {
    console.error('Unable to start Neighborly backend:', error);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (backendProcess) {
    backendProcess.kill();
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('before-quit', () => {
  if (backendProcess) {
    backendProcess.kill();
  }
});
