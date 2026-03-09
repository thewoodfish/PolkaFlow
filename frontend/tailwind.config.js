/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        pk: {
          pink:        "#E6007A",
          "pink-dim":  "#B8005E",
          purple:      "#552BBF",
          "purple-dim":"#3D1FA8",
          dark:        "#1A1A2E",
          card:        "#16213E",
          deep:        "#0F3460",
        },
      },
      animation: {
        "pulse-pk":  "pulse-pk 2s ease-in-out infinite",
        "flow-line": "flow-line 1.4s linear infinite",
        "slide-up":  "slide-up 0.25s ease-out",
        "fade-in":   "fade-in 0.2s ease-out",
      },
      keyframes: {
        "pulse-pk": {
          "0%,100%": { boxShadow: "0 0 0 0 rgba(230,0,122,0)" },
          "50%":     { boxShadow: "0 0 18px 4px rgba(230,0,122,0.45)" },
        },
        "flow-line": {
          "0%":   { transform: "translateX(-200%)" },
          "100%": { transform: "translateX(200%)" },
        },
        "slide-up": {
          "0%":   { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "fade-in": {
          "0%":   { opacity: "0" },
          "100%": { opacity: "1" },
        },
      },
    },
  },
  plugins: [],
};
