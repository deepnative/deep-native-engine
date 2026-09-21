PYTHON ?= python3

.PHONY: bootstrap verify
bootstrap:
	$(PYTHON) scripts/repo.py bootstrap

verify:
	$(PYTHON) scripts/repo.py verify
