export interface KeyState {
  w: boolean;
  a: boolean;
  d: boolean;
  space: boolean;
}

export function createInput(): () => KeyState {
  const keys: KeyState = { w: false, a: false, d: false, space: false };
  const alias: Record<string, keyof KeyState | undefined> = {
    arrowup: 'w',
    arrowleft: 'a',
    arrowright: 'd',
    ' ': 'space',
  };

  const keyOf = (e: KeyboardEvent): string => {
    const k = e.key.toLowerCase();
    return alias[k] ?? k;
  };

  const isKey = (k: string): k is keyof KeyState => k in keys;

  const handleKeyDown = (e: KeyboardEvent): void => {
    if (document.activeElement?.tagName === 'INPUT') return;
    const key = keyOf(e);
    if (isKey(key)) {
      keys[key] = true;
      if (key === 'space') e.preventDefault();
    }
  };

  const handleKeyUp = (e: KeyboardEvent): void => {
    const key = keyOf(e);
    if (isKey(key)) keys[key] = false;
  };

  const handleBlur = (): void => {
    keys.w = false;
    keys.a = false;
    keys.d = false;
    keys.space = false;
  };

  window.addEventListener('keydown', handleKeyDown);
  window.addEventListener('keyup', handleKeyUp);
  window.addEventListener('blur', handleBlur);

  // Bind on-screen touch / pointer buttons for mobile & tablet play
  const bindTouchButton = (elementId: string, key: keyof KeyState): void => {
    const btn = document.getElementById(elementId);
    if (!btn) return;

    const press = (e: Event): void => {
      e.preventDefault();
      keys[key] = true;
      btn.classList.add('active');
    };

    const release = (e: Event): void => {
      e.preventDefault();
      keys[key] = false;
      btn.classList.remove('active');
    };

    btn.addEventListener('pointerdown', press);
    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointercancel', release);
    btn.addEventListener('pointerleave', release);
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
  };

  bindTouchButton('touch-left', 'a');
  bindTouchButton('touch-right', 'd');
  bindTouchButton('touch-thrust', 'w');
  bindTouchButton('touch-fire', 'space');

  return (): KeyState => ({ ...keys });
}
