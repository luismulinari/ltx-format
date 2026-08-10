import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'node',
		include: ['test/**/*.test.ts'],
		coverage: {
			provider: 'v8',
			include: ['src/**/*.ts'],
			reporter: ['text', 'lcov'],
			thresholds: {
				lines: 96,
				functions: 95,
				branches: 88,
				statements: 96,
			},
		},
	},
});
