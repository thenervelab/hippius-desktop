import type { Config } from "tailwindcss";
import containerQueries from "@tailwindcss/container-queries";

export default {
  // darkMode: "class",
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      screens: {
        compact: "900px",
        desktop: "1310px",
        short: { raw: "(max-height: 890px)" },
        "max-sm": { max: "639px" },
        "max-md": { max: "767px" },
        "max-lg": { max: "1023px" },
        "max-xl": { max: "1279px" },
        "max-2xl": { max: "1535px" },
      },
      maxWidth: {
        "screen-1.5xl": "1360px",
        "content-max": "1600px",
        "nav-max": "1600px",
      },
      boxShadow: {
        card: "0px 12px 36px 0px rgba(0, 0, 0, 0.14)",
        "root-nav": "0px 12px 36px 0px rgba(0, 0, 0, 0.14)",
        tooltip: "0px 12px 36px 0px rgba(0, 0, 0, 0.14)",
        "banner-scroll": "-4px 0px 0px 0px rgba(31, 81, 190, 0.8) inset",
        menu: "0px 12px 36px 0px #00000024",
        drop: "0px 12px 25px 0px #00000014",
        "input-shadow": "0px 0px 0px 4px rgba(10, 10, 10, 0.05)",
        "inner-button":
          "0px 4px 4px 0px #0441951A,0px 2px 9px 0px #3D8CFA99 inset",
        "outer-button":
          "0px 4px 4px 0px #0441951A,0px 2px 9px 0px #3D8CFA99 inset",
        dialog: "0px 12px 36px 0px #00000024",
        "inner-action-button":
          "0 2px 9px 0 rgba(61, 140, 250, 0.60) inset, 0 4px 4px 0 rgba(4, 65, 149, 0.10)",
        "outer-action-button":
          " 0 2px 9px 0 rgba(61, 140, 250, 0.60) inset, 0 4px 4px 0 rgba(4, 65, 149, 0.10)",
        "tab-active":
          "0px 12.26px 3.831px 0px rgba(0,0,0,0), 0px 8.429px 3.065px 0px rgba(0,0,0,0.01), 0px 4.597px 3.065px 0px rgba(0,0,0,0.04), 0px 2.299px 2.299px 0px rgba(0,0,0,0.08), 0px 0.766px 0.766px 0px rgba(0,0,0,0.09)",
      },
      backgroundImage: {
        "white-cloud-gradient":
          "radial-gradient(16.34% 38.34%, #fff0 0%, #fff 100%);",
        "white-cloud-gradient-lg":
          "radial-gradient(80.34% 80.34% at 50% 50%, rgba(255, 255, 255, 0) 0%, #FFFFFF 100%)",
        "white-cloud-gradient-md":
          "radial-gradient(50% 50% at 50% 50%, rgba(255, 255, 255, 0) 0%, #FFFFFF 100%)",
        "white-cloud-gradient-sm":
          "radial-gradient(70% 70% at 50% 50%, rgba(255, 255, 255, 0) 0%, #FFFFFF 100%)",
      },
      fontFamily: {
        inter: "var(--font-inter)",
        sans: "var(--font-geist-sans)",
        mono: "var(--font-geist-mono)",
        digital: "digitalFonts",
      },
      colors: {
        "table-header": "#FAFAFA",
        success: {
          100: "rgb(var(--success-100) / <alpha-value>)",
          90: "rgb(var(--success-90) / <alpha-value>)",
          80: "rgb(var(--success-80) / <alpha-value>)",
          70: "rgb(var(--success-70) / <alpha-value>)",
          60: "rgb(var(--success-60) / <alpha-value>)",
          50: "rgb(var(--success-50) / <alpha-value>)",
          40: "rgb(var(--success-40) / <alpha-value>)",
          30: "rgb(var(--success-30) / <alpha-value>)",
          20: "rgb(var(--success-20) / <alpha-value>)",
          10: "rgb(var(--success-10) / <alpha-value>)",
        },
        primary: {
          "brand-dark": "rgb(var(--brand-dark) / <alpha-value>)",
          100: "rgb(var(--primary-100) / <alpha-value>)",
          90: "rgb(var(--primary-90) / <alpha-value>)",
          80: "rgb(var(--primary-80) / <alpha-value>)",
          70: "rgb(var(--primary-70) / <alpha-value>)",
          65: "rgb(var(--primary-65) / <alpha-value>)",
          60: "rgb(var(--primary-60) / <alpha-value>)",
          50: "rgb(var(--primary-50) / <alpha-value>)",
          40: "rgb(var(--primary-40) / <alpha-value>)",
          30: "rgb(var(--primary-30) / <alpha-value>)",
          20: "rgb(var(--primary-20) / <alpha-value>)",
          10: "rgb(var(--primary-10) / <alpha-value>)",
        },
        black: {
          "primary-bg": "rgb(var(--black-primary-bg) / <alpha-value>)",
          100: "rgb(var(--black-100) / <alpha-value>)",
          200: "rgb(var(--black-200) / <alpha-value>)",
          300: "rgb(var(--black-300) / <alpha-value>)",
          400: "rgb(var(--black-400) / <alpha-value>)",
          500: "rgb(var(--black-500) / <alpha-value>)",
          600: "rgb(var(--black-600) / <alpha-value>)",
          700: "rgb(var(--black-700) / <alpha-value>)",
          800: "rgb(var(--black-800) / <alpha-value>)",
          850: "rgb(var(--black-850) / <alpha-value>)",
          900: "rgb(var(--black-900) / <alpha-value>)",
        },
        grey: {
          100: "rgb(var(--grey-100) / <alpha-value>)",
          90: "rgb(var(--grey-90) / <alpha-value>)",
          85: "rgb(var(--grey-85) / <alpha-value>)",
          80: "rgb(var(--grey-80) / <alpha-value>)",
          70: "rgb(var(--grey-70) / <alpha-value>)",
          60: "rgb(var(--grey-60) / <alpha-value>)",
          50: "rgb(var(--grey-50) / <alpha-value>)",
          40: "rgb(var(--grey-40) / <alpha-value>)",
          30: "rgb(var(--grey-30) / <alpha-value>)",
          20: "rgb(var(--grey-20) / <alpha-value>)",
          10: "rgb(var(--grey-10) / <alpha-value>)",
          "primary-bg": "rgb(var(--grey-primary-bg) / <alpha-value>)",
          "light-100": "rgb(var(--grey-light-100) / <alpha-value>)",
          "light-200": "rgb(var(--grey-light-200) / <alpha-value>)",
          "light-300": "rgb(var(--grey-light-300) / <alpha-value>)",
          "light-400": "rgb(var(--grey-light-400) / <alpha-value>)",
          "light-500": "rgb(var(--grey-light-500) / <alpha-value>)",
          "light-600": "rgb(var(--grey-light-600) / <alpha-value>)",
          "light-700": "rgb(var(--grey-light-700) / <alpha-value>)",
          "light-800": "rgb(var(--grey-light-800) / <alpha-value>)",
          "dark-100": "rgb(var(--grey-dark-100) / <alpha-value>)",
          "dark-200": "rgb(var(--grey-dark-200) / <alpha-value>)",
          "dark-300": "rgb(var(--grey-dark-300) / <alpha-value>)",
          "dark-400": "rgb(var(--grey-dark-400) / <alpha-value>)",
          "dark-500": "rgb(var(--grey-dark-500) / <alpha-value>)",
          "dark-600": "rgb(var(--grey-dark-600) / <alpha-value>)",
          "dark-700": "rgb(var(--grey-dark-700) / <alpha-value>)",
          "dark-800": "rgb(var(--grey-dark-800) / <alpha-value>)",
          "dark-900": "rgb(var(--grey-dark-900) / <alpha-value>)",
        },
        warning: {
          100: "rgb(var(--warning-100) / <alpha-value>)",
          200: "rgb(var(--warning-200) / <alpha-value>)",
          300: "rgb(var(--warning-300) / <alpha-value>)",
          90: "rgb(var(--warning-90) / <alpha-value>)",
          80: "rgb(var(--warning-80) / <alpha-value>)",
          70: "rgb(var(--warning-70) / <alpha-value>)",
          60: "rgb(var(--warning-60) / <alpha-value>)",
          50: "rgb(var(--warning-50) / <alpha-value>)",
          40: "rgb(var(--warning-40) / <alpha-value>)",
          30: "rgb(var(--warning-30) / <alpha-value>)",
          20: "rgb(var(--warning-20) / <alpha-value>)",
          10: "rgb(var(--warning-10) / <alpha-value>)",
        },
        error: {
          100: "rgb(var(--error-100) / <alpha-value>)",
          90: "rgb(var(--error-90) / <alpha-value>)",
          80: "rgb(var(--error-80) / <alpha-value>)",
          70: "rgb(var(--error-70) / <alpha-value>)",
          60: "rgb(var(--error-60) / <alpha-value>)",
          50: "rgb(var(--error-50) / <alpha-value>)",
          40: "rgb(var(--error-40) / <alpha-value>)",
          30: "rgb(var(--error-30) / <alpha-value>)",
          20: "rgb(var(--error-20) / <alpha-value>)",
          10: "rgb(var(--error-10) / <alpha-value>)",
        },
      },
      zIndex: {
        1: "1",
        3: "3",
        4: "4",
        5: "5",
      },
      keyframes: {
        ["spin-fast"]: {
          "100%": { transform: "rotate(360deg)" },
        },
        ["spin-reverse-fast"]: {
          "100%": { transform: "rotate(-360deg)" },
        },
        ["spin-medium"]: {
          "100%": { transform: "rotate(360deg)" },
        },
        ["spin-reverse"]: {
          to: { transform: "translate(-50%, -50%) rotate(-360deg)" },
        },
        ["fade-in"]: {
          "0%": {
            opacity: "0",
          },
          "100%": {
            opacity: "1",
          },
        },
        ["fade-out"]: {
          "0%": {
            opacity: "1",
          },
          "100%": {
            opacity: "0",
          },
        },
        ["fade-in-from-b"]: {
          "0%": {
            opacity: "0",
            transform: "translateY(10px)",
          },
          "100%": {
            opacity: "1",
            transform: "translateY(0px)",
          },
        },
        ["fade-out-to-b"]: {
          "0%": {
            opacity: "1",
            transform: "translateY(0px)",
          },
          "100%": {
            opacity: "0",
            transform: "translateY(10px)",
          },
        },
        ["scale-in-95"]: {
          "0%": {
            opacity: "0",
            transform: "scale(0.95)",
          },
          "100%": {
            opacity: "1",
            transform: "scale(1.0)",
          },
        },
        ["scale-out-95"]: {
          "0%": {
            opacity: "1",
            transform: "scale(1.0)",
          },
          "100%": {
            opacity: "0",
            transform: "scale(0.95)",
          },
        },
        ["scale-down-75%"]: {
          "0%": {
            opacity: "1",
            transform: "scale(1)",
          },
          "100%": {
            opacity: "0",
            transform: "scale(0.75)",
          },
        },
        ["scale-in-75%"]: {
          "0%": {
            opacity: "0",
            transform: "scale(0.75)",
          },
          "100%": {
            opacity: "1",
            transform: "scale(1)",
          },
        },
        ["node-pulse-30%"]: {
          "0%, 100%": {
            opacity: "1",
            transform: "scale(1)",
          },
          "50%": {
            opacity: "0.5",
            transform: "scale(1.3)",
          },
        },
        ["scale-in-100%"]: {
          "0%": {
            opacity: "0",
            transform: "scale(0)",
          },
          "100%": {
            opacity: "1",
            transform: "scale(1)",
          },
        },
        // Sync widget collapse/expand. Paired with `origin-bottom-left`
        // (sidebar) or `origin-bottom-right` (portal) so the mini ring and the
        // full card appear to grow out of that corner, mirroring the old
        // SyncStatusDialog2 expand.
        ["widget-grow"]: {
          "0%": {
            opacity: "0",
            transform: "scale(0.8)",
          },
          "100%": {
            opacity: "1",
            transform: "scale(1)",
          },
        },
        ["tooltip-reveal-left"]: {
          "0%": {
            opacity: "0",
            transform: "translateX(-20px)",
          },
          "100%": {
            opacity: "1",
            transform: "translateX(0px)",
          },
        },
        ["tooltip-reveal-right"]: {
          "0%": {
            opacity: "0",
            transform: "translateX(20px)",
          },
          "100%": {
            opacity: "1",
            transform: "translateX(0px)",
          },
        },
        ["tooltip-reveal-top"]: {
          "0%": {
            opacity: "0",
            transform: "translateY(-20px)",
          },
          "100%": {
            opacity: "1",
            transform: "translateY(0px)",
          },
        },
        ["tooltip-reveal-bottom"]: {
          "0%": {
            opacity: "0",
            transform: "translateY(20px)",
          },
          "100%": {
            opacity: "1",
            transform: "translateY(0px)",
          },
        },
        ["slide-down"]: {
          "0%": {
            height: "0",
            opacity: "0",
          },
          "100%": {
            height: "var(--radix-accordion-content-height)",
            opacity: "1",
          },
        },
        ["slide-up"]: {
          "0%": {
            height: "var(--radix-accordion-content-height)",
            opacity: "1",
          },
          "100%": {
            height: "0",
            opacity: "0",
          },
        },
        // Add new keyframes for glyph animations
        ["translate-from-bottom"]: {
          "0%": {
            opacity: "0",
            transform: "translateY(100px)",
          },
          "100%": {
            opacity: "1",
            transform: "translateY(0)",
          },
        },
        ["translate-update"]: {
          "0%": {
            opacity: "0.7",
            transform: "translateY(15px)",
          },
          "70%": {
            opacity: "1",
          },
          "100%": {
            transform: "translateY(0)",
          },
        },
        "panel-in": {
          from: { transform: "translateX(100%)" },
          to: { transform: "translateX(0)" },
        },
        "panel-out": {
          from: { transform: "translateX(0)" },
          to: { transform: "translateX(100%)" },
        },
        shake: {
          "0%, 100%": { transform: "translateX(0)" },
          "25%": { transform: "translateX(-4px)" },
          "75%": { transform: "translateX(4px)" },
        },
      },
      backgroundSize: {
        full: "100% 100%",
      },
      animation: {
        ["fade-out-0.2"]: "fade-out 0.2s ease-in-out forwards",
        ["fade-in-0.2"]: "fade-in 0.2s ease-in-out forwards",
        ["fade-in-0.5"]: "fade-in 0.5s ease-in-out forwards",
        ["fade-in-from-b-0.5"]: "fade-in-from-b 0.5s ease-in-out forwards",
        ["fade-in-from-b-0.3"]: "fade-in-from-b 0.3s ease-in-out forwards",
        ["fade-out-to-b-0.3"]: "fade-out-to-b 0.3s ease-in-out forwards",
        ["scale-down-75%-0.3"]: "scale-down-75% 0.3s ease-in-out forwards",
        ["scale-in-75%-0.3"]: "scale-in-75% 0.3s ease-in-out forwards",
        ["scale-in-100%-0.3"]: "scale-in-100% 0.3s ease-in-out forwards",
        ["node-pulse-30%"]: "node-pulse-30% 1.5s ease-in-out infinite",
        ["tooltip-reveal-bottom"]:
          "tooltip-reveal-bottom 0.3s ease-in-out forwards",
        ["tooltip-reveal-top"]: "tooltip-reveal-top 0.3s ease-in-out forwards",
        ["tooltip-reveal-left"]:
          "tooltip-reveal-left 0.3s ease-in-out forwards",
        ["tooltip-reveal-right"]:
          "tooltip-reveal-right 0.3s ease-in-out forwards",
        "scale-in-95-0.2": "scale-in-95 0.2s ease-in-out forwards",
        "scale-out-95-0.2": "scale-out-95 0.2s ease-in-out forwards",
        "widget-grow-0.3": "widget-grow 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards",
        ["slideDown"]: "slide-down 0.3s ease-out",
        ["slideUp"]: "slide-up 0.3s ease-out",
        ["translate-from-bottom"]:
          "translate-from-bottom 0.8s cubic-bezier(0.16, 1, 0.3, 1) forwards",
        ["translate-update"]:
          "translate-update 0.6s cubic-bezier(0.4, 0, 0.2, 1) forwards",
        ["spin-fast"]: "spin 4s linear infinite",
        ["spin-medium"]: "spin 6s linear infinite",
        ["spin-slow"]: "spin 8s linear infinite",
        ["spin-reverse-really-fast"]: "spin-reverse 1s linear infinite",
        ["spin-reverse-fast"]: "spin-reverse 4s linear infinite",
        ["spin-reverse-medium"]: "spin-reverse 6s linear infinite",
        ["spin-reverse-slow"]: "spin-reverse 8s linear infinite",
        "panel-in": "panel-in 0.2s ease-out",
        "panel-out": "panel-out 0.2s ease-in",
        shake: "shake 0.3s ease-in-out",
      },
    },
  },
  plugins: [containerQueries],
} satisfies Config;
