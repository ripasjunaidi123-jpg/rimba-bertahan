import { useCallback, useEffect, useRef, useState } from 'react';
import { ActionControls } from './components/ActionControls';
import { BackpackModal } from './components/BackpackModal';
import { CraftingModal } from './components/CraftingModal';
import { GameHud } from './components/GameHud';
import { GameOverModal, PauseModal } from './components/GameOverlayModals';
import { QuickItemBar } from './components/QuickItemBar';
import { SettingsModal } from './components/SettingsModal';
import { ShopModal } from './components/ShopModal';
import { TerritoryModal } from './components/TerritoryModal';
import { TitleScreen } from './components/TitleScreen';
import { VirtualJoystick } from './components/VirtualJoystick';
import { WorldMapModal } from './components/WorldMapModal';
import { soundEngine } from './game/audio';
import {
  buyCitySpecialItem,
  buyPet,
  buyShopItem,
  claimTerritoryLeadership,
  collectTreasury,
  craftRecipe,
  createInitialWorld,
  cycleActiveWeapon,
  cycleDeployable,
  discardBackpackSlot,
  enactRoyalDecree,
  equipWeapon,
  getHudSnapshot,
  getNearbyCaveEntrance,
  isNearCaveExit,
  performAttack,
  performDash,
  placeStructure,
  sellBackpackItem,
  throwGrenade,
  toggleCavePortal,
  toggleEquipPet,
  updateWorld,
  useBackpackSlot,
  useHealingItem,
} from './game/engine';
import { loadGameSettings, saveGameSettings, type GameSettings } from './game/settings';
import { ThreeWorldRenderer } from './game/threeRenderer';
import type {
  GameState,
  GameWorld,
  HudSnapshot,
  PetKind,
  ResourceKey,
  StructureKind,
  Vector2D,
  WeaponId,
} from './game/types';

const BEST_SCORE_KEY = 'rimba_bertahan_best_v2';

interface BestRecord {
  kills: number;
  days: number;
}

function loadBestRecord(): BestRecord {
  try {
    const raw = localStorage.getItem(BEST_SCORE_KEY);
    if (!raw) return { kills: 0, days: 1 };
    const parsed = JSON.parse(raw) as Partial<BestRecord>;
    return {
      kills: typeof parsed.kills === 'number' ? parsed.kills : 0,
      days: typeof parsed.days === 'number' ? parsed.days : 1,
    };
  } catch {
    return { kills: 0, days: 1 };
  }
}

export default function App() {
  const [gameState, setGameState] = useState<GameState>('TITLE_MENU');
  const gameStateRef = useRef<GameState>(gameState);
  gameStateRef.current = gameState;

  const [settings, setSettings] = useState<GameSettings>(loadGameSettings);
  const settingsRef = useRef<GameSettings>(settings);
  settingsRef.current = settings;
  const [showSettings, setShowSettings] = useState(false);

  const [bestRecord, setBestRecord] = useState<BestRecord>(loadBestRecord);

  const worldRef = useRef<GameWorld>(createInitialWorld());
  const [hud, setHud] = useState<HudSnapshot>(() => getHudSnapshot(worldRef.current));

  const mountRef = useRef<HTMLDivElement | null>(null);
  const threeRendererRef = useRef<ThreeWorldRenderer | null>(null);
  const analogVecRef = useRef<Vector2D>({ x: 0, y: 0 });
  const keysPressedRef = useRef<Set<string>>(new Set());
  const [keyboardVec, setKeyboardVec] = useState<Vector2D>({ x: 0, y: 0 });

  // Sync audio master volume & graphics quality whenever settings change
  useEffect(() => {
    saveGameSettings(settings);
    soundEngine.setMasterVolume(settings.volume);
    soundEngine.setMuted(settings.muted);
    threeRendererRef.current?.setGraphicsQuality(settings.graphicsQuality);
  }, [settings]);

  // Auto-unlock eerie wilderness ambient audio on first user interaction anywhere
  useEffect(() => {
    const unlockOnce = () => {
      soundEngine.unlock();
    };
    window.addEventListener('pointerdown', unlockOnce, { once: true });
    window.addEventListener('keydown', unlockOnce, { once: true });
    return () => {
      window.removeEventListener('pointerdown', unlockOnce);
      window.removeEventListener('keydown', unlockOnce);
    };
  }, []);

  // Pointer drag state for Third-Person camera orbit
  const camDragRef = useRef<{
    pointerId: number | null;
    lastX: number;
    lastY: number;
    movedPx: number;
  }>({ pointerId: null, lastX: 0, lastY: 0, movedPx: 0 });
  const cameraTurnAccumRef = useRef<number>(0);

  const computeCombinedInput = useCallback((): Vector2D => {
    const analog = analogVecRef.current;
    const analogMag = Math.hypot(analog.x, analog.y);
    if (analogMag > 0.06) {
      const sens = settingsRef.current.controlSensitivity;
      const scaledMag = Math.min(1, analogMag * (0.7 + 0.3 * sens));
      return {
        x: (analog.x / analogMag) * scaledMag,
        y: (analog.y / analogMag) * scaledMag,
      };
    }
    const keys = keysPressedRef.current;
    let kx = 0;
    let ky = 0;
    if (keys.has('KeyA')) kx -= 1;
    if (keys.has('KeyD')) kx += 1;
    if (keys.has('KeyW') || keys.has('ArrowUp')) ky -= 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) ky += 1;
    const len = Math.hypot(kx, ky);
    if (len > 1) {
      kx /= len;
      ky /= len;
    }
    return { x: kx, y: ky };
  }, []);

  const syncHud = useCallback(() => {
    setHud(getHudSnapshot(worldRef.current));
  }, []);

  const syncBestRecord = useCallback((snapshot: HudSnapshot) => {
    setBestRecord((prev) => {
      const next: BestRecord = {
        kills: Math.max(prev.kills, snapshot.kills),
        days: Math.max(prev.days, snapshot.dayWave),
      };
      if (next.kills !== prev.kills || next.days !== prev.days) {
        try {
          localStorage.setItem(BEST_SCORE_KEY, JSON.stringify(next));
        } catch {
          // Ignore storage quota errors
        }
      }
      return next;
    });
  }, []);

  const startNewGame = useCallback(() => {
    soundEngine.unlock();
    analogVecRef.current = { x: 0, y: 0 };
    keysPressedRef.current.clear();
    cameraTurnAccumRef.current = 0;
    setKeyboardVec({ x: 0, y: 0 });
    worldRef.current = createInitialWorld();
    setHud(getHudSnapshot(worldRef.current));
    setGameState('PLAYING');
  }, []);

  const handleAttack = useCallback(() => {
    if (gameStateRef.current !== 'PLAYING') return;
    soundEngine.unlock();
    performAttack(worldRef.current);
    syncHud();
  }, [syncHud]);

  const handleDash = useCallback(() => {
    if (gameStateRef.current !== 'PLAYING') return;
    soundEngine.unlock();
    performDash(worldRef.current, computeCombinedInput());
  }, [computeCombinedInput]);

  const handleUseHealing = useCallback(() => {
    if (gameStateRef.current !== 'PLAYING' && gameStateRef.current !== 'CRAFTING') return;
    soundEngine.unlock();
    if (useHealingItem(worldRef.current)) {
      syncHud();
    }
  }, [syncHud]);

  const handleThrowGrenade = useCallback(() => {
    if (gameStateRef.current !== 'PLAYING') return;
    soundEngine.unlock();
    if (throwGrenade(worldRef.current)) {
      syncHud();
    }
  }, [syncHud]);

  const handleCycleWeapon = useCallback(() => {
    if (gameStateRef.current !== 'PLAYING') return;
    soundEngine.unlock();
    if (cycleActiveWeapon(worldRef.current)) {
      syncHud();
    }
  }, [syncHud]);

  const handleEquipWeapon = useCallback(
    (weaponId: WeaponId) => {
      soundEngine.unlock();
      if (equipWeapon(worldRef.current, weaponId)) {
        syncHud();
      }
    },
    [syncHud]
  );

  const handleCraftRecipe = useCallback(
    (recipeId: string) => {
      soundEngine.unlock();
      if (craftRecipe(worldRef.current, recipeId)) {
        syncHud();
      }
    },
    [syncHud]
  );

  const handlePlaceStructure = useCallback(
    (kind: StructureKind) => {
      soundEngine.unlock();
      if (placeStructure(worldRef.current, kind)) {
        syncHud();
      }
    },
    [syncHud]
  );

  const handleCycleDeployable = useCallback(() => {
    soundEngine.unlock();
    cycleDeployable(worldRef.current);
    syncHud();
  }, [syncHud]);

  const handleToggleCave = useCallback(() => {
    if (gameStateRef.current !== 'PLAYING') return;
    soundEngine.unlock();
    if (toggleCavePortal(worldRef.current)) {
      syncHud();
    }
  }, [syncHud]);

  const handleUseBackpackSlot = useCallback(
    (slotIdx: number) => {
      soundEngine.unlock();
      if (useBackpackSlot(worldRef.current, slotIdx)) {
        syncHud();
      }
    },
    [syncHud]
  );

  const handleDiscardBackpackSlot = useCallback(
    (slotIdx: number, discardAll = false) => {
      soundEngine.unlock();
      if (discardBackpackSlot(worldRef.current, slotIdx, discardAll)) {
        syncHud();
      }
    },
    [syncHud]
  );

  const handleBuyPet = useCallback(
    (kind: PetKind) => {
      soundEngine.unlock();
      if (buyPet(worldRef.current, kind)) {
        syncHud();
      }
    },
    [syncHud]
  );

  const handleTogglePet = useCallback(
    (kind: PetKind) => {
      soundEngine.unlock();
      if (toggleEquipPet(worldRef.current, kind)) {
        syncHud();
      }
    },
    [syncHud]
  );

  const handleBuyShopItem = useCallback(
    (offerId: string) => {
      soundEngine.unlock();
      if (buyShopItem(worldRef.current, offerId)) {
        syncHud();
      }
    },
    [syncHud]
  );

  const handleSellItem = useCallback(
    (itemId: ResourceKey | 'meat', amount: number) => {
      soundEngine.unlock();
      if (sellBackpackItem(worldRef.current, itemId, amount)) {
        syncHud();
      }
    },
    [syncHud]
  );

  const handleBuyCitySpecialItem = useCallback(
    (offerId: string) => {
      soundEngine.unlock();
      if (buyCitySpecialItem(worldRef.current, offerId)) {
        syncHud();
      }
    },
    [syncHud]
  );

  const handleClaimLeadership = useCallback(
    (territoryId: string) => {
      soundEngine.unlock();
      if (claimTerritoryLeadership(worldRef.current, territoryId)) {
        syncHud();
      }
    },
    [syncHud]
  );

  const handleCollectTreasury = useCallback(() => {
    soundEngine.unlock();
    if (collectTreasury(worldRef.current) > 0) {
      syncHud();
    }
  }, [syncHud]);

  const handleEnactDecree = useCallback(
    (kind: 'prosperity' | 'war' | 'festival') => {
      soundEngine.unlock();
      if (enactRoyalDecree(worldRef.current, kind)) {
        syncHud();
      }
    },
    [syncHud]
  );

  const handleToggleMute = useCallback(() => {
    soundEngine.unlock();
    setSettings((prev) => ({
      ...prev,
      muted: !prev.muted,
    }));
  }, []);

  // Keyboard support for desktop testing & play
  useEffect(() => {
    const syncKeyboardDisplay = () => {
      const keys = keysPressedRef.current;
      let kx = 0;
      let ky = 0;
      if (keys.has('KeyA')) kx -= 1;
      if (keys.has('KeyD')) kx += 1;
      if (keys.has('KeyW') || keys.has('ArrowUp')) ky -= 1;
      if (keys.has('KeyS') || keys.has('ArrowDown')) ky += 1;
      const len = Math.hypot(kx, ky);
      if (len > 1) {
        kx /= len;
        ky /= len;
      }
      setKeyboardVec({ x: kx, y: ky });
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) {
        if (gameStateRef.current === 'PLAYING') e.preventDefault();
      }
      if (e.code === 'Escape') {
        if (showSettings) {
          setShowSettings(false);
          return;
        }
        setGameState((prev) =>
          prev === 'PLAYING'
            ? 'PAUSED'
            : prev === 'PAUSED' ||
                prev === 'CRAFTING' ||
                prev === 'BACKPACK' ||
                prev === 'SHOP' ||
                prev === 'TERRITORY' ||
                prev === 'MAP'
              ? 'PLAYING'
              : prev
        );
        return;
      }
      if (e.code === 'KeyC') {
        setGameState((prev) =>
          prev === 'PLAYING' ? 'CRAFTING' : prev === 'CRAFTING' ? 'PLAYING' : prev
        );
        return;
      }
      if (e.code === 'KeyB' || e.code === 'KeyI') {
        setGameState((prev) =>
          prev === 'PLAYING' ? 'BACKPACK' : prev === 'BACKPACK' ? 'PLAYING' : prev
        );
        return;
      }
      if (e.code === 'KeyT') {
        setGameState((prev) =>
          prev === 'PLAYING' ? 'SHOP' : prev === 'SHOP' ? 'PLAYING' : prev
        );
        return;
      }
      if (e.code === 'KeyN') {
        setGameState((prev) =>
          prev === 'PLAYING' ? 'TERRITORY' : prev === 'TERRITORY' ? 'PLAYING' : prev
        );
        return;
      }
      if (e.code === 'KeyM') {
        setGameState((prev) =>
          prev === 'PLAYING' ? 'MAP' : prev === 'MAP' ? 'PLAYING' : prev
        );
        return;
      }
      if (gameStateRef.current !== 'PLAYING' || showSettings) return;

      if (e.code === 'Space' || e.code === 'KeyJ') {
        handleAttack();
        return;
      }
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight' || e.code === 'KeyK') {
        handleDash();
        return;
      }
      if (e.code === 'KeyE') {
        const w = worldRef.current;
        if (getNearbyCaveEntrance(w) || isNearCaveExit(w)) {
          handleToggleCave();
        } else {
          handleUseHealing();
        }
        return;
      }
      if (e.code === 'KeyG') {
        handleThrowGrenade();
        return;
      }
      if (e.code === 'KeyQ') {
        handleCycleWeapon();
        return;
      }
      if (e.code === 'KeyF') {
        const selected = worldRef.current.player.selectedDeploy;
        if (selected) handlePlaceStructure(selected);
        return;
      }

      keysPressedRef.current.add(e.code);
      syncKeyboardDisplay();
    };

    const onKeyUp = (e: KeyboardEvent) => {
      keysPressedRef.current.delete(e.code);
      syncKeyboardDisplay();
    };

    const onBlur = () => {
      keysPressedRef.current.clear();
      analogVecRef.current = { x: 0, y: 0 };
      setKeyboardVec({ x: 0, y: 0 });
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [
    handleAttack,
    handleDash,
    handleUseHealing,
    handleThrowGrenade,
    handleCycleWeapon,
    handlePlaceStructure,
    handleToggleCave,
    showSettings,
  ]);

  // Isolated Three.js WebGL Engine Lifecycle (active whenever not on TITLE_MENU)
  const inSession = gameState !== 'TITLE_MENU';

  useEffect(() => {
    if (!inSession) return;
    const container = mountRef.current;
    if (!container) return;

    const threeRenderer = new ThreeWorldRenderer(
      container,
      settingsRef.current.graphicsQuality
    );
    threeRendererRef.current = threeRenderer;
    let disposed = false;

    const handleResize = () => {
      if (!container) return;
      threeRenderer.resize(container.clientWidth || window.innerWidth, container.clientHeight || window.innerHeight);
    };
    window.addEventListener('resize', handleResize);

    let lastTime = performance.now();
    let hudAccumulator = 0;

    const tick = (now: number) => {
      if (disposed) return;
      const dt = Math.min((now - lastTime) / 1000, 0.08);
      lastTime = now;

      if (gameStateRef.current === 'PLAYING') {
        const moveVec = computeCombinedInput();
        const keys = keysPressedRef.current;
        const turnSpeed = 2.2 * settingsRef.current.controlSensitivity;
        let arrowTurn = 0;
        if (keys.has('ArrowLeft')) arrowTurn -= turnSpeed * dt;
        if (keys.has('ArrowRight')) arrowTurn += turnSpeed * dt;

        const turnDelta = cameraTurnAccumRef.current + arrowTurn;
        cameraTurnAccumRef.current = 0;

        updateWorld(worldRef.current, dt, moveVec, turnDelta);

        hudAccumulator += dt;
        if (hudAccumulator >= 0.08 || worldRef.current.player.hp <= 0) {
          hudAccumulator = 0;
          const snap = getHudSnapshot(worldRef.current);
          setHud(snap);
          if (worldRef.current.player.hp <= 0) {
            syncBestRecord(snap);
            setGameState('GAME_OVER');
          }
        }
      }

      threeRenderer.render(worldRef.current, dt);
      threeRenderer.afterDraw(tick);
    };

    threeRenderer.afterDraw(tick);

    return () => {
      disposed = true;
      threeRendererRef.current = null;
      window.removeEventListener('resize', handleResize);
      threeRenderer.dispose();
    };
  }, [inSession, computeCombinedInput, syncBestRecord]);

  if (gameState === 'TITLE_MENU') {
    return (
      <>
        <TitleScreen
          bestKills={bestRecord.kills}
          bestDays={bestRecord.days}
          onStartGame={startNewGame}
          onOpenSettings={() => {
            soundEngine.unlock();
            setShowSettings(true);
          }}
        />
        {showSettings && (
          <SettingsModal
            settings={settings}
            onChange={setSettings}
            onClose={() => setShowSettings(false)}
          />
        )}
      </>
    );
  }

  return (
    <main className="touch-game-surface relative h-full w-full overflow-hidden bg-[#1D2229]">
      {/* Dedicated Empty WebGL Mount Container */}
      <div
        ref={mountRef}
        onPointerDown={(e) => {
          if (gameState !== 'PLAYING' || camDragRef.current.pointerId !== null) return;
          camDragRef.current = {
            pointerId: e.pointerId,
            lastX: e.clientX,
            lastY: e.clientY,
            movedPx: 0,
          };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const drag = camDragRef.current;
          if (drag.pointerId !== e.pointerId) return;
          const dx = e.clientX - drag.lastX;
          const dy = e.clientY - drag.lastY;
          drag.lastX = e.clientX;
          drag.lastY = e.clientY;
          drag.movedPx += Math.hypot(dx, dy);
          const sens = settingsRef.current.controlSensitivity;
          cameraTurnAccumRef.current += dx * 0.0065 * sens;
          const p = worldRef.current.player;
          p.cameraPitch = Math.max(
            0.06,
            Math.min(0.72, p.cameraPitch + dy * 0.0028 * sens)
          );
        }}
        onPointerUp={(e) => {
          const drag = camDragRef.current;
          if (drag.pointerId !== e.pointerId) return;
          if (e.pointerType === 'mouse' && e.button === 0 && drag.movedPx < 6) {
            handleAttack();
          }
          camDragRef.current.pointerId = null;
        }}
        onPointerCancel={(e) => {
          if (camDragRef.current.pointerId === e.pointerId) {
            camDragRef.current.pointerId = null;
          }
        }}
        className="touch-game-surface h-full w-full"
      />

      <GameHud
        world={worldRef.current}
        hud={hud}
        isMuted={settings.muted || settings.volume === 0}
        onOpenCrafting={() =>
          setGameState((prev) =>
            prev === 'PLAYING' ? 'CRAFTING' : prev === 'CRAFTING' ? 'PLAYING' : prev
          )
        }
        onOpenBackpack={() =>
          setGameState((prev) =>
            prev === 'PLAYING' ? 'BACKPACK' : prev === 'BACKPACK' ? 'PLAYING' : prev
          )
        }
        onOpenShop={() =>
          setGameState((prev) =>
            prev === 'PLAYING' ? 'SHOP' : prev === 'SHOP' ? 'PLAYING' : prev
          )
        }
        onOpenTerritory={() =>
          setGameState((prev) =>
            prev === 'PLAYING' ? 'TERRITORY' : prev === 'TERRITORY' ? 'PLAYING' : prev
          )
        }
        onOpenMap={() =>
          setGameState((prev) =>
            prev === 'PLAYING' ? 'MAP' : prev === 'MAP' ? 'PLAYING' : prev
          )
        }
        onToggleMute={handleToggleMute}
        onPause={() => setGameState((prev) => (prev === 'PLAYING' ? 'PAUSED' : 'PLAYING'))}
      />

      {/* Floating Loot, XP & Level-Up Hints */}
      {gameState === 'PLAYING' && hud.floatingHints.length > 0 && (
        <div className="pointer-events-none fixed top-[84px] left-1/2 -translate-x-1/2 z-10 flex flex-col items-center gap-1">
          {hud.floatingHints.map((fh) => (
            <div
              key={fh.id}
              className="px-2.5 py-0.5 rounded-full bg-black/50 border border-white/18 font-mono text-[11px] font-bold whitespace-nowrap"
              style={{ color: fh.color, opacity: Math.min(1, fh.lifeRatio * 1.4) }}
            >
              {fh.text}
            </div>
          ))}
        </div>
      )}

      {gameState === 'PLAYING' && (
        <>
          <VirtualJoystick
            onChange={(vec) => {
              analogVecRef.current = vec;
            }}
            keyboardVector={keyboardVec}
            scale={settings.joystickScale}
          />

          <QuickItemBar
            hud={hud}
            onCycleWeapon={handleCycleWeapon}
            onUseHealing={handleUseHealing}
            onThrowGrenade={handleThrowGrenade}
            onPlaceSelectedStructure={handlePlaceStructure}
            onCycleDeployable={handleCycleDeployable}
            onOpenBackpack={() => setGameState('BACKPACK')}
          />

          <ActionControls
            hud={hud}
            scale={settings.actionButtonScale}
            onAttack={handleAttack}
            onDash={handleDash}
            onToggleCave={handleToggleCave}
            onOpenTerritory={() => setGameState('TERRITORY')}
          />
        </>
      )}

      {gameState === 'CRAFTING' && (
        <CraftingModal
          hud={hud}
          onClose={() => setGameState('PLAYING')}
          onCraft={handleCraftRecipe}
          onEquipWeapon={handleEquipWeapon}
          onPlaceStructure={handlePlaceStructure}
          onUseHealing={handleUseHealing}
        />
      )}

      {gameState === 'BACKPACK' && (
        <BackpackModal
          hud={hud}
          onClose={() => setGameState('PLAYING')}
          onUseSlot={handleUseBackpackSlot}
          onDiscardSlot={handleDiscardBackpackSlot}
        />
      )}

      {gameState === 'SHOP' && (
        <ShopModal
          hud={hud}
          onClose={() => setGameState('PLAYING')}
          onBuyPet={handleBuyPet}
          onTogglePet={handleTogglePet}
          onBuyItem={handleBuyShopItem}
          onSellItem={handleSellItem}
          onBuyCitySpecialItem={handleBuyCitySpecialItem}
        />
      )}

      {gameState === 'TERRITORY' && (
        <TerritoryModal
          hud={hud}
          world={worldRef.current}
          onClose={() => setGameState('PLAYING')}
          onClaimLeadership={handleClaimLeadership}
          onCollectTreasury={handleCollectTreasury}
          onEnactDecree={handleEnactDecree}
          onBuySpecialItem={handleBuyCitySpecialItem}
        />
      )}

      {gameState === 'MAP' && (
        <WorldMapModal
          world={worldRef.current}
          hud={hud}
          onClose={() => setGameState('PLAYING')}
        />
      )}

      {gameState === 'PAUSED' && (
        <PauseModal
          onResume={() => setGameState('PLAYING')}
          onOpenSettings={() => setShowSettings(true)}
          onRestart={startNewGame}
          onMainMenu={() => setGameState('TITLE_MENU')}
        />
      )}

      {showSettings && (
        <SettingsModal
          settings={settings}
          onChange={setSettings}
          onClose={() => setShowSettings(false)}
        />
      )}

      {gameState === 'GAME_OVER' && (
        <GameOverModal
          hud={hud}
          bestKills={bestRecord.kills}
          onRestart={startNewGame}
          onMainMenu={() => setGameState('TITLE_MENU')}
        />
      )}
    </main>
  );
}
