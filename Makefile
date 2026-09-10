.PHONY: eval test goldens seed dev walk start

eval: test goldens walk

test:
	pnpm test

goldens:
	pnpm --filter @sapiensq/evals eval

walk:
	pnpm --filter @sapiensq/evals walk

seed:
	pnpm seed

dev:
	pnpm dev

start:
	pnpm start

install:
	pnpm install
