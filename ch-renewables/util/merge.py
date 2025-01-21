import json
from pyproj import Transformer

translations = {}
transformer = Transformer.from_crs("EPSG:2056", "EPSG:4326")

for file in ["MainCategoryCatalogue.csv",
             "OrientationCatalogue.csv",
             "PlantCategoryCatalogue.csv",
             "SubCategoryCatalogue.csv"]:
    with open(file) as f:
        for l in f:
            if l.startswith('Catalogue'):
                continue
            code, *translations_list = l.strip().split(',')
            translations[code] = translations_list[-1]

def to_lat_lon(e, n):
    # Convert from LV95 to LV03 first
    y = int(e) - 2000000
    x = int(n) - 1000000    
    # Then convert to WGS84
    y_aux = (y - 600000) / 1000000
    x_aux = (x - 200000) / 1000000

    lat = (16.9023892 +
           (3.238272 * x_aux) +
           (0.270978 * y_aux * y_aux) +
           (0.002528 * x_aux * x_aux) +
           (0.0447 * y_aux * y_aux * y_aux) +
           (-0.0140 * x_aux * x_aux * x_aux))
    lon = (2.6779094 +
           (4.728982 * y_aux) +
           (0.791484 * x_aux * y_aux) +
           (0.1306 * y_aux * y_aux * y_aux) +
           (-0.0436 * x_aux * x_aux * y_aux))
    return lat + 46.95, lon + 7.439583333333333

res, keys, values = [], [], []
with open("ElectricityProductionPlant.csv", encoding='utf8') as f:
    for l in f:
        if 'xtf_id' in l:
            keys = l.strip().split(',')
            keys += ['lat', 'lon']
            continue
        values = l.strip().split(',')
        for i, value in enumerate(values):
            if value in translations:
                values[i] = translations[value]
            elif value.replace('.', '').isdigit():
                values[i] = float(value) if '.' in value else int(value)
        if isinstance(values[-2], int) and isinstance(values[-1], int):
            values += transformer.transform(values[-2], values[-1])
        else:
            values += [None, None]
        res.append(dict(zip(keys, values)))

with open("ElectricityProductionPlant.json", "w", encoding="utf-8") as f:
    json.dump(res, f, indent=2, ensure_ascii=False)
