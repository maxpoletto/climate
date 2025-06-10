.PHONY: testfiles serve clean deps

JSON_FILES = app/data/facilities.json app/data/prod.json

testfiles: $(JSON_FILES)
	@echo "Test files are up to date"

serve: testfiles deps
	@echo "Starting development server..."
	cd app && python3 -m http.server 8000

%.json: %.json.gz
	@echo "Decompressing $@"
	gunzip -k $<

deps:
	pip3.12 install -r requirements.txt

clean:
	@echo "Cleaning up..."
	rm -f $(JSON_FILES)
