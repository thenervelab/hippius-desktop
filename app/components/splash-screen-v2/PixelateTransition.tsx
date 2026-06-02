'use client'

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import gsap from 'gsap'

type PixelateTransitionProps = {
  color?: string
  /** Size of each cell in pixels when gridSize is not provided */
  cellSize?: number
  /** Fixed grid dimension (NxN). If provided, overrides cellSize-based layout. */
  gridSize?: number
  /** Total animation time for the dissolve (per-cell stagger auto-computed) */
  duration?: number
  /** Delay before starting the dissolve */
  delay?: number
  /** GSAP stagger origin: 'center' | 'random' | index */
  from?: 'center' | 'random' | number
  /** Additional container classes */
  className?: string
}

export default function PixelateTransition({
  color = '#0F0507',
  cellSize = 144,
  gridSize,
  duration = 1,
  delay = 0,
  from = 'center',
  className = '',
}: PixelateTransitionProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [visible, setVisible] = useState(true)
  const [grid, setGrid] = useState({ cols: 0, rows: 0 })

  // compute grid before first paint to avoid initial flicker
  useLayoutEffect(() => {
    if (gridSize && gridSize > 0) {
      setGrid({ cols: gridSize, rows: gridSize })
      return
    }

    const width = window.innerWidth
    const height = window.innerHeight
    const cols = Math.ceil(width / cellSize)
    const rows = Math.ceil(height / cellSize)
    setGrid({ cols, rows })
  }, [cellSize, gridSize])

  // recompute on resize when using cellSize layout
  useEffect(() => {
    if (gridSize && gridSize > 0) return
    const onResize = () => {
      const width = window.innerWidth
      const height = window.innerHeight
      const cols = Math.ceil(width / cellSize)
      const rows = Math.ceil(height / cellSize)
      setGrid({ cols, rows })
    }
    window.addEventListener('resize', onResize)
    window.addEventListener('orientationchange', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('orientationchange', onResize)
    }
  }, [cellSize, gridSize])

  const totalCells = useMemo(() => grid.cols * grid.rows, [grid.cols, grid.rows])
  const cells = useMemo(() => Array.from({ length: totalCells }, (_, i) => i), [totalCells])

  useEffect(() => {
    if (!containerRef.current || totalCells === 0) return

    const squares = Array.from(containerRef.current.querySelectorAll('[data-square="true"]'))

    const tl = gsap.timeline({ defaults: { ease: 'power2.inOut' }, delay })

    // ensure overlay starts fully visible
    gsap.set(containerRef.current, { opacity: 1 })
    gsap.set(squares, { scale: 1.02, transformOrigin: '50% 50%', force3D: true })

    // split total time between the per-square tween and stagger gaps so total ≈ duration
    const perSquareDuration = Math.max(0.12, duration * 0.45)
    const perCellGap = Math.max(0.001, (duration - perSquareDuration) / Math.max(1, totalCells - 1))

    // when from === 'random', shuffle target order and use simple numeric stagger for true randomness
    const randomizedSquares = from === 'random' ? gsap.utils.shuffle([...squares]) : squares

    tl.to(randomizedSquares, {
      opacity: 0,
      scale: 0.85,
      duration: perSquareDuration,
      stagger: from === 'random'
        ? perCellGap
        : {
          each: perCellGap,
          grid: [grid.rows, grid.cols],
          from,
        },
    })
      .to(containerRef.current, { opacity: 0, duration: Math.min(0.35, duration * 0.3) }, '-=0.2')
      .add(() => setVisible(false))

    return () => {
      tl.kill()
    }
  }, [delay, duration, totalCells, grid.cols, grid.rows, from])

  if (!visible) return null

  return (
    <div
      ref={containerRef}
      className={[
        'fixed inset-0 z-[10000] pointer-events-none select-none',
        className,
      ].join(' ')}
      style={{}}
    >
      {totalCells === 0 && (
        <div className="absolute inset-0" style={{ backgroundColor: color }} />
      )}
      {cells.map((i) => (
        (() => {
          const colIndex = i % grid.cols
          const rowIndex = Math.floor(i / grid.cols)
          const widthPercent = 100 / Math.max(1, grid.cols)
          const heightPercent = 100 / Math.max(1, grid.rows)
          const leftPercent = colIndex * widthPercent
          const topPercent = rowIndex * heightPercent
          return (
            <div
              key={i}
              data-square="true"
              className="will-change-transform absolute"
              style={{
                backgroundColor: color,
                backfaceVisibility: 'hidden',
                transform: 'translateZ(0)',
                left: `${leftPercent}%`,
                top: `${topPercent}%`,
                width: `${widthPercent}%`,
                height: `${heightPercent}%`,
              }}
            />
          )
        })()
      ))}
    </div>
  )
}
