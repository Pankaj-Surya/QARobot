import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#17202a",
        mist: "#f5f7fb",
        line: "#dce3ec",
        action: "#2563eb",
      },
    },
  },
  plugins: [],
};

export default config;
