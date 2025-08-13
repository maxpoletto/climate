.PHONY: all import prod-data test-data test-server \
setup-cron remove-cron clean clean-docker clean-all

ROOT_PATH = app
DATA_PATH = $(ROOT_PATH)/data
JSON_FILES = $(DATA_PATH)/facilities.json $(DATA_PATH)/production.json
GZ_FILES = $(JSON_FILES:.json=.json.gz)

all:
	@echo "Use 'make test-server' to start the test server"
	@echo "Use 'make prod-data' to set up data for the production server"
	@echo "Use 'make test-data' to set up data for the test server"
	@echo "Use 'make import' to import data from online sources"
	@echo "Use 'make setup-cron' to set up weekly cron job"
	@echo "Use 'make clean' or 'make clean-all' to clean up"
	@echo ""
	@echo "First time setup: write MapTiler API key to app/maptiler-key.txt"

docker-build: Dockerfile requirements.txt bin/import_data.py
	docker build -t ch-energy-importer .
	@touch docker-build

import: docker-build
	mkdir -p $(DATA_PATH)
	docker run --rm \
		-v $(PWD)/$(DATA_PATH):/app/data \
		ch-energy-importer \
		--dest_root . --geocode-cache data/geocode-cache.txt

prod-data: import
	chmod 444 $(GZ_FILES)

test-data: import $(JSON_FILES)
	@echo "Test files are up to date"

test-server: test-data
	@echo "Starting development server..."
	cd $(ROOT_PATH) && python3 -m http.server 8000 &

%.json: %.json.gz
	@echo "Decompressing $@"
	gunzip -k $<

setup-cron:
	bin/setup_cron.sh

remove-cron:
	bin/remove_cron.sh

clean:
	@echo "Cleaning up..."
	rm -f $(JSON_FILES)

clean-docker:
	@echo "Cleaning Docker build cache..."
	rm -f docker-build
	docker rmi ch-energy-importer 2>/dev/null || true

clean-all: clean clean-docker remove-cron
