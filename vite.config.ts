import { defineConfig } from 'vite-plus';

export default defineConfig({
  lint: {
    options: { typeAware: true, typeCheck: true },
  },
  fmt: { singleQuote: true },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
