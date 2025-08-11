FROM python:3.13-slim

WORKDIR /app

# Copy requirements first for better layer caching
COPY requirements.txt .
RUN pip install -r requirements.txt

# Copy the import script
COPY bin/import_data.py bin/

ENTRYPOINT ["python", "bin/import_data.py"]