import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        border: "hsl(214 32% 91%)",
        background: "hsl(0 0% 100%)",
        foreground: "hsl(222 47% 11%)",
        muted: "hsl(210 40% 96%)",
        primary: "hsl(221 83% 53%)",
        destructive: "hsl(0 84% 60%)",
      },
      borderRadius: {
        lg: "0.5rem",
        md: "0.375rem",
      },
    },
  },
  plugins: [],
};

export default config;
