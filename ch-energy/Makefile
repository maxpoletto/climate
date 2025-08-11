.PHONY: all clean cleanall deps docker-clean import serve testfiles setup-cron remove-cron

ROOT_PATH = app
DATA_PATH = $(ROOT_PATH)/data
JSON_FILES = $(DATA_PATH)/facilities.json $(DATA_PATH)/production.json
GZ_FILES = $(JSON_FILES:.json=.json.gz)

all:
	@echo "Use 'make dev' to start the development server"
	@echo "Use 'make prod' to start the production server"
	@echo "Use 'make import' to import the data"
	@echo "Use 'make setup-cron' to set up weekly cron job"
	@echo "Use 'make clean' to clean up"
	@echo ""
	@echo "First time setup: write MapTiler API key to app/maptiler-key.txt"

prod: deps import
	chmod 444 $(GZ_FILES)

dev: deps testfiles
	@echo "Starting development server..."
	cd $(ROOT_PATH) && python3 -m http.server 8000

deps:
	pip install -r requirements.txt

docker-build: Dockerfile requirements.txt
	docker build -t ch-energy-importer .
	@touch docker-build

testfiles: import $(JSON_FILES)
	@echo "Test files are up to date"

import: docker-build
	mkdir -p $(DATA_PATH)
	docker run --rm \
		-v $(PWD)/$(DATA_PATH):/app/data \
		ch-energy-importer \
		--dest_root . --geocode-cache data/geocode-cache.txt

setup-cron:
	bin/setup_cron.sh

remove-cron:
	bin/remove_cron.sh

%.json: %.json.gz
	@echo "Decompressing $@"
	gunzip -k $<

clean:
	@echo "Cleaning up..."
	rm -f $(JSON_FILES)

docker-clean:
	@echo "Cleaning Docker build cache..."
	rm -f docker-build
	docker rmi ch-energy-importer 2>/dev/null || true

cleanall: clean docker-clean remove-cron
