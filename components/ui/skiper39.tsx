"use client";

import { gsap } from "gsap";
import React, { useEffect, useRef } from "react";

import { cn } from "@/lib/utils";

interface CrowdCanvasProps {
  src: string;
  rows?: number;
  cols?: number;
  /** Replaces the default canvas sizing/positioning classes. */
  className?: string;
  /** Drawn size of each person relative to the sprite sheet (default 1). */
  scale?: number;
  /** People on stage per 100px of width; omit to use every sprite. */
  density?: number;
  /**
   * Share of the stage height (0–1) people may walk above the bottom edge.
   * Higher walkers are drawn smaller, fainter and slower for depth.
   */
  spread?: number;
}

const CrowdCanvas = ({
  src,
  rows = 15,
  cols = 7,
  className,
  scale = 1,
  density,
  spread,
}: CrowdCanvasProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const config = {
      src,
      rows,
      cols,
    };

    // UTILS
    const randomRange = (min: number, max: number) =>
      min + Math.random() * (max - min);
    const randomIndex = <T,>(array: T[]) => randomRange(0, array.length) | 0;
    const removeFromArray = <T,>(array: T[], i: number) => array.splice(i, 1)[0];
    const removeItemFromArray = <T,>(array: T[], item: T) =>
      removeFromArray(array, array.indexOf(item));
    const removeRandomFromArray = <T,>(array: T[]) =>
      removeFromArray(array, randomIndex(array));
    const getRandomFromArray = <T,>(array: T[]) => array[randomIndex(array) | 0];

    // TWEEN FACTORIES
    const resetPeep = ({ stage, peep }: { stage: Stage; peep: Peep }) => {
      const direction = Math.random() > 0.5 ? 1 : -1;

      // With `spread`, some people walk higher up the stage; the higher they
      // are, the further away they read (smaller, fainter, slower).
      const lift = spread ? Math.pow(Math.random(), 1.6) * spread * stage.height : 0;
      peep.depth = spread ? 1 - lift / (spread * stage.height) : 1;
      peep.drawScale = spread ? 0.6 + 0.4 * peep.depth : 1;

      const drawWidth = peep.width * peep.drawScale;
      const drawHeight = peep.height * peep.drawScale;
      const offsetY =
        (100 - 250 * gsap.parseEase("power2.in")(Math.random())) *
        scale *
        peep.drawScale;
      const startY = stage.height - drawHeight + offsetY - lift;
      let startX: number;
      let endX: number;

      if (direction === 1) {
        startX = -drawWidth;
        endX = stage.width;
        peep.scaleX = 1;
      } else {
        startX = stage.width + drawWidth;
        endX = 0;
        peep.scaleX = -1;
      }

      peep.x = startX;
      peep.y = startY;
      peep.anchorY = startY;

      return {
        startX,
        startY,
        endX,
      };
    };

    const normalWalk = ({ peep, props }: { peep: Peep; props: WalkProps }) => {
      const { startY, endX } = props;
      const xDuration = 10;
      const yDuration = 0.25;

      const tl = gsap.timeline();
      tl.timeScale(randomRange(0.5, 1.5) * (0.65 + 0.35 * peep.depth));
      tl.to(
        peep,
        {
          duration: xDuration,
          x: endX,
          ease: "none",
        },
        0,
      );
      tl.to(
        peep,
        {
          duration: yDuration,
          repeat: xDuration / yDuration,
          yoyo: true,
          y: startY - 10 * scale * peep.drawScale,
        },
        0,
      );

      return tl;
    };

    const walks = [normalWalk];

    // TYPES
    type Stage = { width: number; height: number };
    type WalkProps = { startX: number; startY: number; endX: number };
    type Peep = {
      image: HTMLImageElement;
      rect: number[];
      width: number;
      height: number;
      drawArgs: unknown[];
      x: number;
      y: number;
      anchorY: number;
      scaleX: number;
      /** 1 = front of the crowd, 0 = furthest back (only varies with `spread`). */
      depth: number;
      drawScale: number;
      walk: gsap.core.Timeline | null;
      setRect: (rect: number[]) => void;
      render: (ctx: CanvasRenderingContext2D) => void;
    };

    // FACTORY FUNCTIONS
    const createPeep = ({
      image,
      rect,
    }: {
      image: HTMLImageElement;
      rect: number[];
    }): Peep => {
      const peep: Peep = {
        image,
        rect: [],
        width: 0,
        height: 0,
        drawArgs: [],
        x: 0,
        y: 0,
        anchorY: 0,
        scaleX: 1,
        depth: 1,
        drawScale: 1,
        walk: null,
        setRect: (rect: number[]) => {
          peep.rect = rect;
          peep.width = rect[2] * scale;
          peep.height = rect[3] * scale;
          peep.drawArgs = [peep.image, ...rect, 0, 0, peep.width, peep.height];
        },
        render: (ctx: CanvasRenderingContext2D) => {
          ctx.save();
          ctx.globalAlpha = 0.45 + 0.55 * peep.depth;
          ctx.translate(peep.x, peep.y);
          ctx.scale(peep.scaleX, 1);
          ctx.drawImage(
            peep.image,
            peep.rect[0],
            peep.rect[1],
            peep.rect[2],
            peep.rect[3],
            0,
            0,
            peep.width * peep.drawScale,
            peep.height * peep.drawScale,
          );
          ctx.restore();
        },
      };

      peep.setRect(rect);
      return peep;
    };

    // MAIN
    const img = document.createElement("img");
    const stage: Stage = {
      width: 0,
      height: 0,
    };

    const allPeeps: Peep[] = [];
    const availablePeeps: Peep[] = [];
    const crowd: Peep[] = [];

    const createPeeps = () => {
      const { rows, cols } = config;
      const { naturalWidth: width, naturalHeight: height } = img;
      const total = rows * cols;
      const rectWidth = width / rows;
      const rectHeight = height / cols;

      for (let i = 0; i < total; i++) {
        allPeeps.push(
          createPeep({
            image: img,
            rect: [
              (i % rows) * rectWidth,
              ((i / rows) | 0) * rectHeight,
              rectWidth,
              rectHeight,
            ],
          }),
        );
      }
    };

    const crowdSize = () =>
      density === undefined
        ? allPeeps.length
        : Math.min(allPeeps.length, Math.round((stage.width / 100) * density));

    const initCrowd = () => {
      const size = crowdSize();
      while (availablePeeps.length && crowd.length < size) {
        addPeepToCrowd().walk?.progress(Math.random());
      }
    };

    const addPeepToCrowd = () => {
      const peep = removeRandomFromArray(availablePeeps);
      const walk = getRandomFromArray(walks)({
        peep,
        props: resetPeep({
          peep,
          stage,
        }),
      }).eventCallback("onComplete", () => {
        removePeepFromCrowd(peep);
        addPeepToCrowd();
      });

      peep.walk = walk;

      crowd.push(peep);
      crowd.sort((a, b) => a.anchorY - b.anchorY);

      return peep;
    };

    const removePeepFromCrowd = (peep: Peep) => {
      removeItemFromArray(crowd, peep);
      availablePeeps.push(peep);
    };

    // Cap the backing-store resolution so large/HiDPI screens stay cheap.
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);

    const render = () => {
      if (!canvas) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.save();
      ctx.scale(pixelRatio, pixelRatio);

      crowd.forEach((peep) => {
        peep.render(ctx);
      });

      ctx.restore();
    };

    // PLAYBACK: runs only while on screen and when motion is allowed;
    // reduced-motion users get a single still frame of the crowd.
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let onScreen = true;
    let playing = false;

    const updatePlayback = () => {
      const shouldPlay = onScreen && !reducedMotion.matches;
      if (shouldPlay === playing) return;
      playing = shouldPlay;
      crowd.forEach((peep) => {
        if (shouldPlay) peep.walk?.resume();
        else peep.walk?.pause();
      });
      if (shouldPlay) gsap.ticker.add(render);
      else gsap.ticker.remove(render);
    };

    const resize = () => {
      if (!canvas) return;
      stage.width = canvas.clientWidth;
      stage.height = canvas.clientHeight;
      canvas.width = stage.width * pixelRatio;
      canvas.height = stage.height * pixelRatio;

      crowd.forEach((peep) => {
        peep.walk?.kill();
      });

      crowd.length = 0;
      availablePeeps.length = 0;
      availablePeeps.push(...allPeeps);

      initCrowd();
      if (!playing) {
        crowd.forEach((peep) => peep.walk?.pause());
        render();
      }
    };

    let ready = false;
    const init = () => {
      createPeeps();
      resize();
      ready = true;
      updatePlayback();
      render();
    };

    img.onload = init;
    img.src = config.src;

    // Only rebuild the crowd when the canvas really changes size (mobile
    // browsers fire resize while the URL bar slides during scrolling).
    const handleResize = () => {
      if (
        ready &&
        (canvas.clientWidth !== stage.width || canvas.clientHeight !== stage.height)
      ) {
        resize();
      }
    };
    window.addEventListener("resize", handleResize);

    const observer = new IntersectionObserver(([entry]) => {
      onScreen = entry.isIntersecting;
      if (ready) updatePlayback();
    });
    observer.observe(canvas);

    const handleMotionChange = () => {
      if (ready) updatePlayback();
    };
    reducedMotion.addEventListener("change", handleMotionChange);

    return () => {
      window.removeEventListener("resize", handleResize);
      reducedMotion.removeEventListener("change", handleMotionChange);
      observer.disconnect();
      img.onload = null;
      gsap.ticker.remove(render);
      crowd.forEach((peep) => {
        if (peep.walk) peep.walk.kill();
      });
    };
  }, [src, rows, cols, scale, density, spread]);
  return (
    <canvas
      ref={canvasRef}
      className={cn("absolute bottom-0 h-[90vh] w-full", className)}
    />
  );
};

const Skiper39 = () => {
  return (
    <div className="relative h-full w-full bg-white text-black">
      <div className="top-22 absolute left-1/2 grid -translate-x-1/2 content-start justify-items-center gap-6 text-center text-black">
        <span className="relative max-w-[12ch] text-xs uppercase leading-tight opacity-40 after:absolute after:left-1/2 after:top-full after:h-16 after:w-px after:bg-gradient-to-b after:from-white after:to-black after:content-['']">
          Croud Canvas
        </span>
      </div>
      <div className="absolute bottom-0 h-full w-screen">
        <CrowdCanvas
          src="https://cdn.21st.dev/assets/localized/abdb8990a7bef8c2f5af3e45f0a3c969c4b0603fba8be92e81347de4ea4e1ed7.png"
          rows={15}
          cols={7}
        />
      </div>
    </div>
  );
};

export { CrowdCanvas, Skiper39 };
export default Skiper39;

/**
 * Skiper 39 Canvas_Landing_004 — React + Canvas
 * Inspired by and adapted from https://codepen.io/zadvorsky/pen/xxwbBQV
 * illustration by https://www.openpeeps.com/
 * We respect the original creators. This is an inspired rebuild with our own taste and does not claim any ownership.
 * These animations aren’t associated with the codepen.io . They’re independent recreations meant to study interaction design
 *
 * License & Usage:
 * - Free to use and modify in both personal and commercial projects.
 * - Attribution to Skiper UI is required when using the free version.
 * - No attribution required with Skiper UI Pro.
 *
 * Feedback and contributions are welcome.
 *
 * Author: @gurvinder-singh02
 * Website: https://gxuri.me
 * Twitter: https://x.com/Gur__vi
 */
