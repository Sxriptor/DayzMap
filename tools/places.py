"""Place recognition index for "where am I": turns the captured pictures (npm run capture:run) into a small
index the app searches with a screenshot. Run with the project's Python (npm run places:setup, once):

  npm run places:build -- <world> [--model eigenplaces|megaloc] [--dim 512] [--limit n]

Reads captures/<world>/shots.csv and img/, writes src/map/<world>/places/:
  model.onnx   a view (uint8 RGB, VIEW_H x VIEW_W, see view()) -> unit-length descriptor of `dim` floats.
               Normalisation and any PCA are inside the graph, so the app only feeds pixels.
  index.bin    one int8 descriptor per picture, in shots order (descriptor = row / scale)
  index.json   model, dim, view size, scale, points [[x, z]] and shots [[point, heading]]
Both models are MIT licensed: EigenPlaces (ResNet50, 512-d as trained) and MegaLoc (DINOv2, 8448-d, cut to
`dim` by a PCA fitted on the pictures). src/places.js does the search; npm run places:eval measures it.
"""
import argparse
import csv
import json
import os
import sys
import random
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
# What the model sees: the top 70% of a 16:9 frame (the bottom holds the player's hands, weapon and status
# icons), scaled to 644 x 252. Both sides are multiples of 14 (MegaLoc's patch size). src/places.js crops a
# screenshot the same way.
VIEW_W, VIEW_H, VIEW_TOP = 644, 252, 0.7
MEAN, STD = [0.485, 0.456, 0.406], [0.229, 0.224, 0.225]  # ImageNet, as both models were trained


def view(image):
    """A 16:9 picture as the model's input: top VIEW_TOP of the frame, resized to VIEW_W x VIEW_H, RGB uint8."""
    image = image.convert('RGB')
    w, h = image.size
    return np.asarray(image.crop((0, 0, w, round(h * VIEW_TOP))).resize((VIEW_W, VIEW_H), Image.BILINEAR))


def load_model(name):
    if name == 'eigenplaces':
        # Its constructor loads CosPlace through torch.hub without trust_repo, which would wait for a y/N answer.
        torch.hub.list('gmberton/cosplace', trust_repo=True)
        return torch.hub.load('gmberton/eigenplaces', 'get_trained_model', backbone='ResNet50', fc_output_dim=512, trust_repo=True)
    if name == 'megaloc':
        return torch.hub.load('gmberton/MegaLoc', 'get_trained_model', trust_repo=True)
    raise SystemExit(f'unknown model {name}: eigenplaces or megaloc')


class GeM(torch.nn.Module):
    """Generalised mean pooling, as EigenPlaces' GeM but with a mean over the map instead of an average pool
    sized from the input (which the ONNX exporter cannot keep as a constant)."""

    def __init__(self, original):
        super().__init__()
        self.p, self.eps = original.p, original.eps

    def forward(self, x):
        return x.clamp(min=self.eps).pow(self.p).mean(dim=(-2, -1), keepdim=True).pow(1.0 / self.p)


def exportable(net):
    for name, child in net.named_children():
        if type(child).__name__ == 'GeM':
            setattr(net, name, GeM(child))
        else:
            exportable(child)
    return net


class Descriptor(torch.nn.Module):
    """uint8 RGB views [n, h, w, 3] -> unit-length descriptors [n, dim], with optional PCA (mean, projection)."""

    def __init__(self, net, mean=None, projection=None):
        super().__init__()
        self.net = net
        self.register_buffer('rgb_mean', torch.tensor(MEAN).view(1, 3, 1, 1))
        self.register_buffer('rgb_std', torch.tensor(STD).view(1, 3, 1, 1))
        self.pca = mean is not None
        if self.pca:
            self.register_buffer('pca_mean', torch.as_tensor(mean, dtype=torch.float32))
            self.register_buffer('pca_projection', torch.as_tensor(projection, dtype=torch.float32))

    def forward(self, rgb):
        x = (rgb.permute(0, 3, 1, 2).float() / 255 - self.rgb_mean) / self.rgb_std
        d = self.net(x)
        if self.pca:
            d = (d - self.pca_mean) @ self.pca_projection
        return F.normalize(d, dim=1)


def read_shots(world):
    folder = ROOT / 'captures' / world
    index = folder / 'shots.csv'
    if not index.exists():
        raise SystemExit(f'no {index}: capture pictures first (npm run capture:run -- {world})')
    with open(index, newline='') as f:
        rows = [r for r in csv.DictReader(f) if (folder / 'img' / f"{r['file']}.jpg").exists()]
    if not rows:
        raise SystemExit(f'{index} lists no pictures that exist in {folder / "img"}')
    return folder, rows


class Views(torch.utils.data.Dataset):
    def __init__(self, folder, rows):
        self.folder, self.rows = folder, rows

    def __len__(self):
        return len(self.rows)

    def __getitem__(self, i):
        return torch.from_numpy(view(Image.open(self.folder / 'img' / f"{self.rows[i]['file']}.jpg")).copy())


def describe(model, folder, rows, device, batch):
    loader = torch.utils.data.DataLoader(Views(folder, rows), batch_size=batch, num_workers=4, pin_memory=True)
    out, done, started = [], 0, time.time()
    with torch.inference_mode(), torch.autocast(device.type, dtype=torch.float16, enabled=device.type == 'cuda'):
        for views in loader:
            out.append(model(views.to(device, non_blocking=True)).float().cpu().numpy())
            done += len(views)
            if len(out) % 50 == 0 or done == len(rows):
                rate = done / (time.time() - started)
                print(f'  {done} of {len(rows)} pictures, {rate:.0f} a second, {(len(rows) - done) / rate / 60:.0f} min left', flush=True)
    return np.concatenate(out)


def fit_pca(raw, dim):
    """PCA to dim: mean and a [raw dim, dim] projection from the top principal directions."""
    mean = raw.mean(0)
    _, _, vt = np.linalg.svd(raw - mean, full_matrices=False)
    return mean, vt[:dim].T.copy()


def export_onnx(model, path):
    model = model.cpu().float().eval()
    dummy = torch.zeros(1, VIEW_H, VIEW_W, 3, dtype=torch.uint8)
    torch.onnx.export(model, (dummy,), str(path), input_names=['view'], output_names=['descriptor'],
                      dynamic_axes={'view': {0: 'n'}, 'descriptor': {0: 'n'}}, opset_version=17, dynamo=False)


def check_onnx(path, model, folder, rows):
    """The exported graph must give the same descriptors as PyTorch on real pictures."""
    import onnxruntime as ort
    sample = [rows[i] for i in random.Random(1).sample(range(len(rows)), min(4, len(rows)))]
    views = np.stack([view(Image.open(folder / 'img' / f"{r['file']}.jpg")) for r in sample])
    with torch.inference_mode():
        expected = model.cpu().float()(torch.from_numpy(views)).numpy()
    got = ort.InferenceSession(str(path), providers=['CPUExecutionProvider']).run(None, {'view': views})[0]
    agreement = float((expected * got).sum(1).min())
    print(f'ONNX check: cosine {agreement:.5f} against PyTorch')
    if agreement < 0.999:
        raise SystemExit('the ONNX model disagrees with PyTorch')


def build(args):
    folder, rows = read_shots(args.world)
    if args.limit:
        rows = rows[:args.limit]
    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    print(f'{args.world}: {len(rows)} pictures, model {args.model}, on {torch.cuda.get_device_name(0) if device.type == "cuda" else "CPU"}')
    net = exportable(load_model(args.model)).eval()
    model = Descriptor(net).to(device).eval()
    # A model wider than dim gets a PCA fitted on a sample of the pictures, folded into the graph.
    probe = model(torch.zeros(1, VIEW_H, VIEW_W, 3, dtype=torch.uint8, device=device)).shape[1]
    if probe > args.dim:
        sample = sorted(random.Random(0).sample(range(len(rows)), min(len(rows), max(args.dim * 8, 8000))))
        print(f'fitting PCA {probe} -> {args.dim} on {len(sample)} pictures')
        raw = describe(model, folder, [rows[i] for i in sample], device, args.batch)
        mean, projection = fit_pca(raw, args.dim)
        model = Descriptor(net, mean, projection).to(device).eval()
    descriptors = describe(model, folder, rows, device, args.batch)

    # Positions: pictures from one spot share a point (the capture logs each spot's eye position once per heading).
    points, shots, at = [], [], {}
    for r in rows:
        key = (round(float(r['x']), 1), round(float(r['z']), 1))
        if key not in at:
            at[key] = len(points)
            points.append(list(key))
        shots.append([at[key], round(float(r['heading']), 1)])
    scale = 127 / float(np.abs(descriptors).max())
    out = ROOT / 'src' / 'map' / args.world / 'places'
    out.mkdir(parents=True, exist_ok=True)
    np.clip(np.round(descriptors * scale), -127, 127).astype(np.int8).tofile(out / 'index.bin')
    fov = float(rows[0]['fov'])
    meta = {'model': args.model, 'dim': int(descriptors.shape[1]), 'view': [VIEW_W, VIEW_H, VIEW_TOP], 'fov': fov,
            'scale': scale, 'points': points, 'shots': shots}
    (out / 'index.json').write_text(json.dumps(meta, separators=(',', ':')))
    export_onnx(model, out / 'model.onnx')
    check_onnx(out / 'model.onnx', model, folder, rows)
    size = sum(f.stat().st_size for f in out.iterdir()) / 1e6
    print(f'Wrote {out}: {len(points)} points, {len(shots)} pictures, {meta["dim"]}-d, {size:.0f} MB')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('command', choices=['build'])
    parser.add_argument('world')
    parser.add_argument('--model', default='eigenplaces')
    parser.add_argument('--dim', type=int, default=512)
    parser.add_argument('--batch', type=int, default=32)
    parser.add_argument('--limit', type=int, default=0)
    args = parser.parse_args()
    build(args)
    # Leave at once: the interpreter's own shutdown can crash in CUDA/loader teardown after the work is saved.
    sys.stdout.flush()
    os._exit(0)
