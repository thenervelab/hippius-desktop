import type { Config } from "tailwindcss";

export default {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      screens: {
        desktop: "1310px",
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

      },
      backgroundImage: {
        "white-cloud-gradient":
          "radial-gradient(16.34% 38.34%, #fff0 0%, #fff 100%);",
        "large-white-cloud-gradient":
          "radial-gradient(80.34% 80.34% at 50% 50%, rgba(255, 255, 255, 0) 0%, #FFFFFF 100%)",
      },
      fontFamily: {
        sans: "var(--font-geist-sans)",
        mono: "var(--font-geist-mono)",
        digital: "digitalFonts",
      },
      colors: {
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
          100: "rgb(var(--primary-100) / <alpha-value>)",
          90: "rgb(var(--primary-90) / <alpha-value>)",
          80: "rgb(var(--primary-80) / <alpha-value>)",
          70: "rgb(var(--primary-70) / <alpha-value>)",
          60: "rgb(var(--primary-60) / <alpha-value>)",
          50: "rgb(var(--primary-50) / <alpha-value>)",
          40: "rgb(var(--primary-40) / <alpha-value>)",
          30: "rgb(var(--primary-30) / <alpha-value>)",
          20: "rgb(var(--primary-20) / <alpha-value>)",
          10: "rgb(var(--primary-10) / <alpha-value>)",
        },
        grey: {
          100: "rgb(var(--grey-100) / <alpha-value>)",
          90: "rgb(var(--grey-90) / <alpha-value>)",
          80: "rgb(var(--grey-80) / <alpha-value>)",
          70: "rgb(var(--grey-70) / <alpha-value>)",
          60: "rgb(var(--grey-60) / <alpha-value>)",
          50: "rgb(var(--grey-50) / <alpha-value>)",
          40: "rgb(var(--grey-40) / <alpha-value>)",
          30: "rgb(var(--grey-30) / <alpha-value>)",
          20: "rgb(var(--grey-20) / <alpha-value>)",
          10: "rgb(var(--grey-10) / <alpha-value>)",
        },
        warning: {
          100: "rgb(var(--warning-100) / <alpha-value>)",
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
        ["slideDown"]: "slide-down 0.3s ease-out",
        ["slideUp"]: "slide-up 0.3s ease-out",
        ["translate-from-bottom"]:
          "translate-from-bottom 0.8s cubic-bezier(0.16, 1, 0.3, 1) forwards",
        ["translate-update"]:
          "translate-update 0.6s cubic-bezier(0.4, 0, 0.2, 1) forwards",
        ["spin-fast"]: "spin 4s linear infinite",
        ["spin-medium"]: "spin 6s linear infinite",
        ["spin-slow"]: "spin 8s linear infinite",
        ["spin-reverse-fast"]: "spin-reverse 4s linear infinite",
        ["spin-reverse-medium"]: "spin-reverse 6s linear infinite",
        ["spin-reverse-slow"]: "spin-reverse 8s linear infinite",
        "panel-in": "panel-in 0.2s ease-out",
        "panel-out": "panel-out 0.2s ease-in",
      },
    },
  },
  plugins: [],
} satisfies Config;
