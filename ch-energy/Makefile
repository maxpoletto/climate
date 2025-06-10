.PHONY: clean deps import serve testfiles

JSON_FILES = app/data/facilities.json app/data/prod.json

serve: deps testfiles
	@echo "Starting development server..."
	cd app && python3 -m http.server 8000

deps:
	pip3.12 install -r requirements.txt

testfiles: import $(JSON_FILES)
	@echo "Test files are up to date"

import:
	mkdir -p app/data
	python3 bin/import_data.py --dest_root app

%.json: %.json.gz
	@echo "Decompressing $@"
	gunzip -k $<

clean:
	@echo "Cleaning up..."
	rm -f $(JSON_FILES)
