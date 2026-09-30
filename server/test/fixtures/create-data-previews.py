"""Deterministic tiny fixtures; files go only to the supplied temporary directory."""
import json
import sqlite3
import sys
from pathlib import Path
import numpy as np
import h5py
import netCDF4
import pyarrow as pa
import pyarrow.feather as feather
import pyarrow.parquet as pq
from openpyxl import Workbook
from scipy.io import savemat, mmwrite
from scipy import sparse
from astropy.io import fits

root = Path(sys.argv[1])
root.mkdir(parents=True, exist_ok=True)
cube = np.arange(24, dtype=float).reshape(2, 3, 4)
np.save(root / 'cube.npy', cube)
np.save(root / 'scalar.npy', np.array(42))
np.save(root / 'text.npy', np.array(['control', 'treated']))
np.save(root / 'missing.npy', np.array([1., np.nan, np.inf, -np.inf, 5.]))
np.save(root / 'huge-values.npy', np.array([1e308, 1e308]))
np.savez(root / 'integers.npz', safe=np.array([-(2**53 - 1), 2**53 - 1], dtype='int64'),
         signed=np.array([[[1, 2]], [[2**53 + 1, 2**53 + 3]]], dtype='int64'),
         unsigned=np.array([2**64 - 1], dtype='uint64'))
np.savez_compressed(root / 'archive.npz', vector=np.arange(8), objects=np.array([{'secret': 'no pickle'}], dtype=object))
with h5py.File(root / 'arrays.h5', 'w') as f:
    group = f.create_group('science')
    group.attrs['units'] = 'arbitrary'
    group['cube'] = cube
    group['cycle'] = group
    f['external'] = h5py.ExternalLink('absent.h5', '/private')
    f['large'] = f.create_dataset('large_data', shape=(10000, 10000), dtype='f4', fillvalue=4)
with netCDF4.Dataset(root / 'weather.nc', 'w') as f:
    f.createDimension('t', 3)
    temp = f.createVariable('temp', 'f4', ('t',), fill_value=-999)
    temp[:] = [2, -999, 6]
savemat(root / 'arrays.mat', {'cube': cube, 'vector': np.arange(5), 'label': 'sample'})
with h5py.File(root / 'modern.mat', 'w') as f:
    f['signal'] = cube
mmwrite(root / 'sparse.mtx', sparse.coo_matrix(([3., 7.], ([0, 1], [0, 1])), shape=(1000000, 1000000)))
fits.HDUList([fits.PrimaryHDU(np.arange(12, dtype=np.float32).reshape(3, 4)), fits.ImageHDU(cube, name='SCIENCE')]).writeto(root / 'image.fits', overwrite=True)
fits.PrimaryHDU(np.arange(12, dtype=np.uint16).reshape(3, 4)).writeto(root / 'scaled.fits', overwrite=True)
book = Workbook()
book.active.title = 'Measurements'
book.active.append(['sample', 'mass', 'formula'])
for i in range(205):
    book.active.append([f'sample-{i}', i * 2.5, '=1+1'])
other = book.create_sheet('Conditions')
other.append(['condition', 'temperature'])
other.append(['control', 24])
book.save(root / 'study.xlsx')
rows = [{'sample': i, 'value': i * 0.5, 'valid': True, 'meta': {'group': 'A'}} for i in range(205)]
(root / 'records.jsonl').write_text('\n'.join(json.dumps(row) for row in rows))
(root / 'empty.jsonl').write_text('')
(root / 'bad.ndjson').write_text('{"x":1}\ninvalid')
(root / 'types.jsonl').write_text('{"id":9007199254740993,"empty":null,"flag":false,"nested":[1,2]}')
with sqlite3.connect(root / 'study.db') as conn:
    conn.execute('CREATE TABLE measurements (sample TEXT, value REAL, extra BLOB)')
    conn.executemany('INSERT INTO measurements VALUES (?, ?, ?)', [(f'sample-{i}', i * 0.5, b'abc') for i in range(205)])
    conn.execute('CREATE TABLE "quoted""table" ("quoted""column" INTEGER)')
    conn.execute('INSERT INTO "quoted""table" VALUES (42)')
    conn.execute('CREATE VIEW hidden_view AS SELECT * FROM measurements')
with sqlite3.connect(root / 'generated.db') as conn:
    conn.execute('CREATE TABLE sqliteData (raw REAL, calibrated REAL GENERATED ALWAYS AS (raw * 2) STORED, offset REAL GENERATED ALWAYS AS (raw - 1) VIRTUAL)')
    conn.execute('INSERT INTO sqliteData (raw) VALUES (2)')
    conn.execute('CREATE VIEW hidden_view AS SELECT * FROM sqliteData')
table = pa.table({'sample': list(range(205)), 'value': [i * 0.5 for i in range(205)]})
for name, factory in [('data.arrow', pa.ipc.new_file), ('data.ipc', pa.ipc.new_stream)]:
    with pa.OSFile(str(root / name), 'wb') as f:
        with factory(f, table.schema) as writer:
            writer.write_table(table, max_chunksize=75)
feather.write_feather(table, root / 'data.feather')
pq.write_table(table, root / 'data.parquet', row_group_size=75)
