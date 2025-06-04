.PHONY: all clean serve help

# Default target
all: app/ElectricityProductionPlant.json

# Decompress the JSON data file if it doesn't exist or is older than the .gz file
app/ElectricityProductionPlant.json: app/ElectricityProductionPlant.json.gz
	@echo "Decompressing data file..."
	gunzip -k $<
	@echo "✅ Data file ready"

# Start development server
serve: app/ElectricityProductionPlant.json
	@echo "Starting development server..."
	cd app && python3 -m http.server 8000

# Install Python dependencies
deps:
	pip3.12 install -r requirements.txt

# Clean up generated files
clean:
	@echo "Cleaning up..."
	rm -f app/ElectricityProductionPlant.json
	@echo "✅ Cleaned"

# Show help
help:
	@echo "Available commands:"
	@echo "  make          - Decompress data file"
	@echo "  make serve    - Start development server (auto-decompresses if needed)"
	@echo "  make clean    - Remove decompressed data file"
	@echo "  make help     - Show this help" 
