PYTHON ?= python3

.PHONY: bootstrap setup db dev verify
bootstrap:
	$(PYTHON) scripts/repo.py bootstrap

setup: bootstrap
	npm ci
	$(MAKE) db
	npx playwright install --with-deps chromium
	@test -f .env || cp .env.example .env

db:
	docker compose up -d --wait

dev:
	npm run dev

verify:
	$(PYTHON) scripts/repo.py verify
