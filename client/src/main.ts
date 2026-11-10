import './style.css';
import { loadAll } from './assets/loader.ts';
import manifestData from './assets/manifest.json';
import { initAudio } from './audio.ts';
import { connection } from './connection.ts';
import { Lobby } from './Lobby.ts';
import { NetGame } from './net/NetGame.ts';

const canvasElement = document.getElementById('gameCanvas');
if (!(canvasElement instanceof HTMLCanvasElement)) {
  throw new Error('Canvas element #gameCanvas not found');
}
const canvas: HTMLCanvasElement = canvasElement;
const ctx = canvas.getContext('2d');
if (!ctx) {
  throw new Error('Could not get 2D canvas context');
}

const width = window.innerWidth;
const height = window.innerHeight;
canvas.width = width;
canvas.height = height;

window.addEventListener('resize', () => {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
});

// Wire up chat form
const chatForm = document.getElementById('chat-form') as HTMLFormElement | null;
const chatInput = document.getElementById('chat-input') as HTMLInputElement | null;
chatForm?.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!chatInput) return;
  const text = chatInput.value.trim();
  if (!text) return;
  connection.send({ type: 'chat', text });
  chatInput.value = '';
});

function drawLoadingScreen(progress: number, text: string = 'Завантаження...'): void {
  if (!ctx) return;
  ctx.fillStyle = '#050814';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#f8fafc';
  ctx.font = 'bold 22px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(text, canvas.width / 2, canvas.height / 2 - 36);
  ctx.strokeStyle = '#38bdf8';
  ctx.lineWidth = 2;
  ctx.strokeRect(canvas.width / 2 - 150, canvas.height / 2 - 10, 300, 16);
  ctx.fillStyle = '#0ea5e9';
  ctx.fillRect(canvas.width / 2 - 148, canvas.height / 2 - 8, 296 * progress, 12);
}

async function bootstrap(_roomData: { room: string; name: string }): Promise<void> {
  const abortController = new AbortController();
  const audioCtx = new AudioContext();
  const game = new NetGame({ canvas, connection });

  try {
    drawLoadingScreen(0, 'Ініціалізація систем корабля...');

    const assets = await loadAll(manifestData, {
      signal: abortController.signal,
      audioCtx,
      onProgress: (ratio) => drawLoadingScreen(ratio, `Завантаження... ${Math.round(ratio * 100)}%`),
    });

    const startGame = (): void => {
      if (audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
      }
      initAudio();
      game.start(assets);
    };

    startGame();
    window.addEventListener(
      'click',
      () => {
        if (audioCtx.state === 'suspended') {
          audioCtx.resume().catch(() => {});
        }
      },
      { once: true },
    );
  } catch (error: unknown) {
    console.error('Помилка завантаження!', error instanceof Error ? error.message : String(error));
    drawLoadingScreen(0, 'Помилка завантаження ресурсів');
  }
}

let activeRoom: string | null = null;
let activePlayerName: string | null = null;

const reconnectBanner = document.getElementById('reconnect-banner');
const reconnectText = document.getElementById('reconnect-text');

connection.onClose = (delay: number) => {
  if (reconnectBanner) {
    reconnectBanner.style.display = 'block';
  }
  if (reconnectText) {
    reconnectText.textContent = `⚠️ Зв'язок із сервером втрачено. Повторне підключення через ${(delay / 1000).toFixed(0)}с...`;
  }
};

connection.onOpen = () => {
  if (reconnectBanner) {
    reconnectBanner.style.display = 'none';
  }
  if (activeRoom && activePlayerName) {
    console.log(`Reconnected! Rejoining room: ${activeRoom}`);
    connection.send({
      type: 'join',
      room: activeRoom,
      name: activePlayerName,
    });
  }
};

const addBotsBtn = document.getElementById('add-bots-btn') as HTMLButtonElement | null;
addBotsBtn?.addEventListener('click', async () => {
  if (!activeRoom) return;
  addBotsBtn.disabled = true;
  addBotsBtn.textContent = '⏳ Додаємо...';
  try {
    await fetch(`/api/rooms/${encodeURIComponent(activeRoom)}/bots`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count: 8 }),
    });
    addBotsBtn.textContent = '🤖 +8 Ботів';
  } finally {
    addBotsBtn.disabled = false;
  }
});

function showLobbyError(msg: string | null): void {
  const errEl = document.getElementById('lobby-error');
  if (!errEl) return;
  if (!msg) {
    errEl.style.display = 'none';
    errEl.textContent = '';
  } else {
    errEl.style.display = 'block';
    errEl.textContent = msg;
  }
}

function initLobby(): void {
  const lobby = new Lobby();
  const uiContainer = document.getElementById('lobby-ui');
  const playerNameInput = document.getElementById('player-name-input') as HTMLInputElement | null;
  const roomNameInput = document.getElementById('room-name-input') as HTMLInputElement | null;
  const createButton = document.getElementById('create-room-btn') as HTMLButtonElement | null;

  if (playerNameInput && !playerNameInput.value) {
    playerNameInput.value = `Пілот_${Math.floor(100 + Math.random() * 900)}`;
  }
  if (roomNameInput && !roomNameInput.value) {
    roomNameInput.value = `sector_${Math.floor(100 + Math.random() * 900)}`;
  }

  const handleCreateRoom = async (): Promise<void> => {
    showLobbyError(null);
    const roomName = roomNameInput?.value.trim() || `sector_${Math.floor(100 + Math.random() * 900)}`;
    const playerName = playerNameInput?.value.trim() || `Пілот_${Math.floor(100 + Math.random() * 900)}`;

    if (createButton) {
      createButton.disabled = true;
      createButton.textContent = '⏳ Створення...';
    }

    try {
      const res = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: roomName }),
      });
      if (!res.ok) {
        const errData = (await res.json().catch(() => ({}))) as { error?: string };
        showLobbyError(`Не вдалося створити кімнату: ${errData.error || res.statusText}`);
        return;
      }

      // Auto-join the newly created room
      connection.send({
        type: 'join',
        room: roomName,
        name: playerName,
      });
      lobby.stop();
      lobby.onJoin?.({ room: roomName, name: playerName });
    } catch (err: unknown) {
      showLobbyError(`Помилка мережі: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (createButton) {
        createButton.disabled = false;
        createButton.textContent = '🚀 Створити кімнату';
      }
    }
  };

  if (createButton) {
    createButton.onclick = handleCreateRoom;
  }
  roomNameInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleCreateRoom();
    }
  });

  lobby.onJoin = (detail) => {
    const { room, name } = detail;
    activeRoom = room;
    activePlayerName = name;
    console.log(`Гравець ${name} увійшов у кімнату ${room}`);

    if (uiContainer) {
      uiContainer.style.display = 'none';
    }

    // Auto-spawn bots if requested via query param, e.g. ?bots=8
    const botsParam = new URLSearchParams(window.location.search).get('bots');
    const botsCount = botsParam ? Number(botsParam) : 0;
    if (botsCount > 0) {
      fetch(`/api/rooms/${encodeURIComponent(room)}/bots`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count: botsCount }),
      }).catch(() => {});
    }

    canvas.style.display = 'block';
    bootstrap(detail);
  };

  // Support URL auto-join for tests or direct links: ?room=abc&name=Player1
  const params = new URLSearchParams(window.location.search);
  const roomParam = params.get('room');
  if (roomParam) {
    const nameParam = params.get('name') || `Пілот_${Math.floor(100 + Math.random() * 900)}`;
    const sendJoin = (): void => {
      connection.send({
        type: 'join',
        room: roomParam,
        name: nameParam,
      });
    };

    if (connection.isConnected) {
      sendJoin();
    } else {
      connection.socket?.addEventListener('open', sendJoin);
    }
    lobby.onJoin({ room: roomParam, name: nameParam });
    return;
  }

  lobby.start();
}

initLobby();
