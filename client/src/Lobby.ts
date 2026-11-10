import { fetchJson } from './assets/loader.ts';
import { connection } from './connection.ts';

export interface RoomListItem {
  id: string;
  name: string;
  players: number;
}

export class Lobby extends EventTarget {
  container: HTMLElement | null;
  private pollInterval: number | null = null;
  onJoin: ((detail: { room: string; name: string }) => void) | null = null;

  constructor(containerElement?: HTMLElement | null) {
    super();
    this.container = containerElement || document.getElementById('room-list') || document.querySelector('.lobby');
  }

  private getPlayerName(): string {
    const input = document.getElementById('player-name-input') as HTMLInputElement | null;
    const val = input?.value.trim();
    if (val) return val;
    return `Пілот_${Math.floor(100 + Math.random() * 900)}`;
  }

  async refresh(): Promise<void> {
    try {
      const rooms = await fetchJson<RoomListItem[]>('/api/rooms');
      this.render(rooms);
    } catch (err: unknown) {
      console.error('Помилка завантаження лобі:', err instanceof Error ? err.message : String(err));
    }
  }

  render(rooms: RoomListItem[]): void {
    const badge = document.getElementById('room-count-badge');
    if (badge) {
      badge.textContent = `🌌 Активні сектори (${rooms.length}/10)`;
    }

    if (!this.container) return;

    if (rooms.length === 0) {
      this.container.innerHTML =
        '<div class="empty-rooms">Наразі немає активних секторів.<br/>Створіть нову кімнату нижче!</div>';
      return;
    }

    this.container.innerHTML = '';

    rooms.forEach((room) => {
      const isFull = room.players >= 8;
      const button = document.createElement('button');
      button.className = 'room-button';
      button.type = 'button';
      button.disabled = isFull;

      const info = document.createElement('div');
      info.className = 'room-button-info';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'room-button-name';
      nameSpan.textContent = `🪐 ${room.name}`;

      const playersSpan = document.createElement('span');
      playersSpan.className = 'room-button-players';
      playersSpan.textContent = `👥 ${room.players}/8`;

      info.appendChild(nameSpan);
      info.appendChild(playersSpan);

      const actionSpan = document.createElement('span');
      actionSpan.className = 'room-button-action';
      actionSpan.textContent = isFull ? '🔒 Повна' : 'Увійти →';

      button.appendChild(info);
      button.appendChild(actionSpan);

      if (!isFull) {
        button.onclick = (): void => {
          const playerName = this.getPlayerName();

          connection.send({
            type: 'join',
            room: room.id,
            name: playerName,
          });

          console.log(`Відправлено запит на вхід у ${room.name} як ${playerName}`);
          this.stop();

          this.onJoin?.({ room: room.id, name: playerName });
          this.dispatchEvent(
            new CustomEvent('join', {
              detail: { room: room.id, name: playerName },
            }),
          );
        };
      }

      this.container?.appendChild(button);
    });
  }

  start(): void {
    if (this.container) {
      this.container.innerHTML = '<div class="empty-rooms">Сканування секторів...</div>';
    }
    this.refresh();
    this.pollInterval = window.setInterval(() => this.refresh(), 2000);
  }

  stop(): void {
    if (this.pollInterval !== null) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }
}
