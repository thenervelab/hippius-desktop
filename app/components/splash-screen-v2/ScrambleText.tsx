'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

interface ScrambleTextProps {
  text: string;
  className?: string;
  characters?: string;
  scrambleSpeed?: number;
  hoverToScramble?: boolean;
  groupHover?: boolean;
  onClick?: () => void;
  as?: 'button' | 'span';
}

export function ScrambleText({
  text,
  className = '',
  characters = 'abcdefghijklmnopqrstuvwxyz!@#$%^&*()_+-=[]{}|;\':\\,./<>?',
  scrambleSpeed = 50,
  hoverToScramble = true,
  groupHover = false,
  onClick,
  as = 'button'
}: ScrambleTextProps) {
  const [displayText, setDisplayText] = useState<string>(text);
  const [isScrambling, setIsScrambling] = useState<boolean>(false);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const charactersArray = characters.split('');
  const originalText = useRef<string>(text);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const spanRef = useRef<HTMLSpanElement>(null);

  // Update original text if prop changes
  useEffect(() => {
    originalText.current = text;
    if (!isScrambling) {
      setDisplayText(text);
    }
  }, [text, isScrambling]);

  const stopScramble = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    setDisplayText(originalText.current);
    setIsScrambling(false);
  }, []);

  const startScramble = useCallback(() => {
    if (isScrambling) return;

    setIsScrambling(true);
    let counter = 0;
    const maxIterations = 10; // Number of scramble iterations

    intervalRef.current = setInterval(() => {
      counter++;

      // Generate scrambled text
      const newText = originalText.current.split('').map((char) => {
        // Gradually reveal original characters toward the end of the animation
        if (counter > maxIterations / 2 && Math.random() < counter / maxIterations) {
          return char;
        }

        // Skip spaces and special characters
        if (char === ' ' || /[^a-zA-Z0-9]/.test(char)) return char;

        // Replace with random character
        return charactersArray[Math.floor(Math.random() * charactersArray.length)];
      }).join('');

      setDisplayText(newText);

      // Stop scrambling after maxIterations
      if (counter >= maxIterations) {
        stopScramble();
      }
    }, scrambleSpeed);
  }, [isScrambling, charactersArray, scrambleSpeed, stopScramble]);

  // Setup group hover effect
  useEffect(() => {
    if (!groupHover) return;

    // Get the current element based on which one is rendered
    const element = as === 'button' ? buttonRef.current : spanRef.current;
    if (!element) return;

    // Find closest parent with 'group' class
    const findGroupParent = (el: HTMLElement): HTMLElement | null => {
      let parent = el.parentElement;
      while (parent) {
        if (parent.className.includes('group')) {
          return parent;
        }
        parent = parent.parentElement;
      }
      return null;
    };

    const groupParent = findGroupParent(element);

    if (groupParent) {
      groupParent.addEventListener('mouseenter', startScramble);
      groupParent.addEventListener('mouseleave', stopScramble);

      return () => {
        groupParent.removeEventListener('mouseenter', startScramble);
        groupParent.removeEventListener('mouseleave', stopScramble);
      };
    }
  }, [groupHover, as, startScramble, stopScramble]);

  useEffect(() => {
    // Cleanup on unmount
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, []);

  const buttonProps = {
    ref: buttonRef,
    className,
    onMouseEnter: (!groupHover && hoverToScramble) ? startScramble : undefined,
    onMouseLeave: (!groupHover && hoverToScramble) ? stopScramble : undefined,
    onClick: () => {
      if (!hoverToScramble) {
        startScramble();
      }
      if (onClick) onClick();
    }
  };

  const spanProps = {
    ref: spanRef,
    className,
    onMouseEnter: (!groupHover && hoverToScramble) ? startScramble : undefined,
    onMouseLeave: (!groupHover && hoverToScramble) ? stopScramble : undefined,
    onClick: () => {
      if (!hoverToScramble) {
        startScramble();
      }
      if (onClick) onClick();
    }
  };

  return as === 'button' ? (
    <button {...buttonProps}>
      {displayText}
    </button>
  ) : (
    <span {...spanProps}>
      {displayText}
    </span>
  );
}

// ScrambleAppearText: animates text in and out with scramble effect on appear/disappear
interface ScrambleAppearTextProps {
  text: string;
  visible: boolean;
  className?: string;
  duration?: number; // total animation duration in ms
  iterations?: number; // number of scramble frames
  characters?: string;
  as?: 'span' | 'div';
}

export function ScrambleAppearText({
  text,
  visible,
  className = '',
  duration = 500,
  iterations = 30,
  characters = 'abcdefghijklmnopqrstuvwxyz!@#$%^&*()_+-=[]{}|;\':\\,./<>?',
  as = 'span',
}: ScrambleAppearTextProps) {
  const [displayText, setDisplayText] = useState(visible ? text : '');
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const prevVisible = useRef(visible);
  const charactersArray = characters.split('');
  const scrambleSpeed = Math.max(10, Math.floor(duration / iterations));

  // Scramble in
  const scrambleIn = useCallback(() => {
    let counter = 0;
    intervalRef.current = setInterval(() => {
      counter++;
      const newText = text.split('').map((char) => {
        if (counter > iterations / 2 && Math.random() < counter / iterations) {
          return char;
        }
        if (char === ' ' || /[^a-zA-Z0-9]/.test(char)) return char;
        return charactersArray[Math.floor(Math.random() * charactersArray.length)];
      }).join('');
      setDisplayText(newText);
      if (counter >= iterations) {
        setDisplayText(text);
        clearInterval(intervalRef.current!);
      }
    }, scrambleSpeed);
  }, [text, scrambleSpeed, charactersArray, iterations]);

  // Scramble out
  const scrambleOut = useCallback(() => {
    let counter = 0;
    intervalRef.current = setInterval(() => {
      counter++;
      const newText = text.split('').map((char) => {
        if (counter > iterations / 2 && Math.random() < counter / iterations) {
          // Fade out to blank
          return '';
        }
        if (char === ' ' || /[^a-zA-Z0-9]/.test(char)) return char;
        return charactersArray[Math.floor(Math.random() * charactersArray.length)];
      }).join('');
      setDisplayText(newText);
      if (counter >= iterations) {
        setDisplayText('');
        clearInterval(intervalRef.current!);
      }
    }, scrambleSpeed);
  }, [text, scrambleSpeed, charactersArray, iterations]);

  useEffect(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    if (prevVisible.current !== visible) {
      if (visible) {
        scrambleIn();
      } else {
        scrambleOut();
      }
      prevVisible.current = visible;
    } else if (!prevVisible.current && visible) {
      // Force scramble on first render when visible
      scrambleIn();
      prevVisible.current = visible;
    } else {
      setDisplayText(visible ? text : '');
    }

    // Cleanup
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [visible, text]);

  if (as === 'div') {
    return <div className={className}>{displayText}</div>;
  }
  return <span className={className}>{displayText}</span>;
}
