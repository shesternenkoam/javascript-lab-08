import './style.css';
import { loadAll } from './assets/loader.ts';
import { initAudio } from './audio.ts';
import { Lobby } from './Lobby.ts';
import { connection } from './connection.ts';
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
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = 'white';
  ctx.font = '24px Arial';
  ctx.textAlign = 'center';
  ctx.fillText(text, width / 2, height / 2 - 40);
  ctx.strokeStyle = 'white';
  ctx.strokeRect(width / 2 - 150, height / 2 - 10, 300, 20);
  ctx.fillStyle = 'green';
  ctx.fillRect(width / 2 - 150, height / 2 - 10, 300 * progress, 20);
}

async function bootstrap(_roomData: { room: string; name: string }): Promise<void> {
  const abortController = new AbortController();
  const audioCtx = new AudioContext();
  const game = new NetGame({ canvas, connection });

  try {
    drawLoadingScreen(0, 'Ініціалізація...');

    const assets = await loadAll('/src/assets/manifest.json', {
      signal: abortController.signal,
      audioCtx,
      onProgress: (ratio) => drawLoadingScreen(ratio, `Завантаження... ${Math.round(ratio * 100)}%`),
    });

    const params = new URLSearchParams(window.location.search);
    const autoPlay = params.get('autoplay') === '1' || params.get('test') === '1';

    const startGame = (): void => {
      if (audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
      }
      initAudio();
      game.start(assets);
    };

    if (autoPlay) {
      startGame();
    } else {
      drawLoadingScreen(1, 'Готово! Клікніть для старту');
      window.addEventListener('click', () => startGame(), { once: true });
    }
  } catch (error: unknown) {
    console.error('Помилка завантаження!', error instanceof Error ? error.message : String(error));
    drawLoadingScreen(0, 'Помилка завантаження (див. консоль).');
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
    addBotsBtn.textContent = '🤖 Додати ще 8 ботів';
  } finally {
    addBotsBtn.disabled = false;
  }
});

function initLobby(): void {
  const lobby = new Lobby();
  const uiContainer = document.getElementById('lobby-ui');

  const createButton = document.createElement('button');
  createButton.id = 'create-room-btn';
  createButton.textContent = '✨ Створити нову кімнату';
  createButton.onclick = async (): Promise<void> => {
    const roomName = prompt('Назва кімнати:', `room_${Math.floor(Math.random() * 1000)}`);
    if (!roomName) return;
    const playerName = prompt("Введіть ваше ім'я:", 'Гравець') || `Player_${Math.floor(Math.random() * 1000)}`;

    try {
      const res = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: roomName }),
      });
      if (!res.ok) {
        const errData = (await res.json().catch(() => ({}))) as { error?: string };
        alert(`Не вдалося створити кімнату: ${errData.error || res.statusText}`);
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
      alert(`Помилка мережі: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  uiContainer?.appendChild(createButton);

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
    const nameParam = params.get('name') || `Player_${Math.floor(Math.random() * 1000)}`;
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
