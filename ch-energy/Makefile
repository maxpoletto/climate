.PHONY: clean deps import serve testfiles

ROOT_PATH = app
DATA_PATH = $(ROOT_PATH)/data
JSON_FILES = $(DATA_PATH)/facilities.json $(DATA_PATH)/production.json
GZ_FILES = $(JSON_FILES:.json=.json.gz)

all:
	@echo "Use 'make dev' to start the development server"
	@echo "Use 'make prod' to start the production server"
	@echo "Use 'make import' to import the data"
	@echo "Use 'make clean' to clean up"

prod: deps import
	chmod 444 $(GZ_FILES)

dev: deps testfiles
	@echo "Starting development server..."
	cd $(ROOT_PATH) && python3 -m http.server 8000

deps:
	pip3.12 install -r requirements.txt

testfiles: import $(JSON_FILES)
	@echo "Test files are up to date"

import:
	mkdir -p $(DATA_PATH)
	python3 bin/import_data.py --dest_root $(ROOT_PATH)

%.json: %.json.gz
	@echo "Decompressing $@"
	gunzip -k $<

clean:
	@echo "Cleaning up..."
	rm -f $(JSON_FILES)
