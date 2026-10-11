#!/usr/bin/env python3
"""Procedurally synthesize the Atlas launch video soundtrack and sound effects.

Everything is generated from scratch with numpy + scipy: no samples, no network.
Run from the worktree root:

    python3 -I video/scripts/make-audio.py

Writes 44.1 kHz / 16-bit stereo WAVs into video/public/audio/:

    music.wav    94.5 s, 120 BPM aero / chillwave pop bed
    send.wav     soft upward "message sent" swoosh
    receive.wav  soft two-note glass/marimba "message received" pop
    whoosh.wav   band-passed noise transition sweep
    ding.wav     FM bell confirmation chime
    tap.wav      tiny UI tap
    sparkle.wav  cascade of high sine pings (logo reveal)
    riser.wav    2 s noise + tone riser that ends on a peak

Music timeline (seconds, 1 bar = 2 s):
    0-8     intro: low-passed pad opening up, clock-like tick, riser 6-8
    8       drop: sub boom + reverse swell resolving + bell chord, groove starts
    8-24    groove A   (8th-note arp, offbeat hats)
    24-40   groove B   (16th arp, 16th hats, shaker, countermelody)
    40-50   groove C   (new arp order, open hats on offbeats)
    50-54   lift: kick out, brighter pads, held bass; fill at 53-54
    54-58   groove back in
    58-74   groove D1  (octave arp, extra percussion, countermelody)
    74-88   groove D2  (densest hats/arps); build 86-88.5
    88.5    final Cmaj9 hit, bells + reverb ring out, silence by 94.5
"""

import functools
import os
import time

import numpy as np
from scipy import signal
from scipy.io import wavfile
from scipy.ndimage import minimum_filter1d, maximum_filter1d, uniform_filter1d

SR = 44100
BPM = 120
BEAT = 60.0 / BPM  # 0.5 s
BAR = 4 * BEAT  # 2.0 s
STEP = BEAT / 4  # 16th note, 0.125 s
DUR = 94.5
N = int(round(DUR * SR))
SWING = 0.018  # seconds the off 16ths are pushed late

OUT_DIR = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "audio")
)


# --------------------------------------------------------------------------
# DSP helpers
# --------------------------------------------------------------------------


def mtof(m):
    return 440.0 * 2.0 ** ((np.asarray(m, dtype=float) - 69.0) / 12.0)


def dbfs(x):
    return 20.0 * np.log10(max(float(x), 1e-12))


def tvec(n):
    return np.arange(n) / SR


def pan_gains(p):
    th = (p + 1.0) * np.pi / 4.0
    return np.cos(th), np.sin(th)


@functools.lru_cache(maxsize=4096)
def _butter(order, lo, hi, btype):
    nyq_safe = 0.45 * SR
    if btype == "low":
        return signal.butter(order, min(lo, nyq_safe), "low", fs=SR, output="sos")
    if btype == "high":
        return signal.butter(order, min(lo, nyq_safe), "high", fs=SR, output="sos")
    return signal.butter(order, [lo, min(hi, nyq_safe)], "bandpass", fs=SR, output="sos")


def lp(x, fc, order=2):
    return signal.sosfilt(_butter(order, float(fc), 0.0, "low"), x, axis=-1)


def hp(x, fc, order=2):
    return signal.sosfilt(_butter(order, float(fc), 0.0, "high"), x, axis=-1)


def bp(x, lo, hi, order=2):
    return signal.sosfilt(_butter(order, float(lo), float(hi), "band"), x, axis=-1)


def tv_filter(x, cut, btype="low", block=256, bw=1.6, order=1):
    """Time-varying 2nd-order Butterworth (low-pass or band-pass), block-wise with
    carried filter state. `cut` is a per-sample cutoff/centre-frequency array."""
    x2 = np.atleast_2d(x)
    y = np.empty_like(x2)
    n = x2.shape[-1]
    zi = None
    for a in range(0, n, block):
        b = min(a + block, n)
        fc = float(cut[(a + b) // 2])
        # quantize to ~0.5% steps so the design cache is effective
        fc = float(np.exp(np.round(np.log(max(fc, 20.0)) * 200.0) / 200.0))
        if btype == "low":
            sos = _butter(2, fc, 0.0, "low")
        else:
            sos = _butter(order, fc / bw, fc * bw, "band")
        if zi is None:
            zi = np.zeros((sos.shape[0],) + x2.shape[:-1] + (2,))
        y[:, a:b], zi = signal.sosfilt(sos, x2[:, a:b], axis=-1, zi=zi)
    return y if np.ndim(x) == 2 else y[0]


def saw_blep(freq, n, phase0=0.0):
    """Band-limited-ish sawtooth (polyBLEP). `freq` may be scalar or per-sample."""
    if np.ndim(freq) == 0:
        dt = np.full(n, freq / SR)
        ph = (phase0 + (freq / SR) * np.arange(n)) % 1.0
    else:
        dt = np.asarray(freq) / SR
        ph = (phase0 + np.cumsum(dt) - dt[0]) % 1.0
    y = 2.0 * ph - 1.0
    m = ph < dt
    t = ph[m] / dt[m]
    y[m] -= t + t - t * t - 1.0
    m = ph > 1.0 - dt
    t = (ph[m] - 1.0) / dt[m]
    y[m] -= t * t + t + t + 1.0
    return y


def fade_edges(x, fade=0.005):
    n = int(fade * SR)
    r = 0.5 - 0.5 * np.cos(np.linspace(0, np.pi, n))
    x[..., :n] *= r
    x[..., -n:] *= r[::-1]
    return x


def tail_fade(n, fade=0.01):
    env = np.ones(n)
    k = min(int(fade * SR), n)
    env[n - k :] = np.linspace(1.0, 0.0, k)
    return env


def add(buf, t, sig, gain=1.0, pan=0.0):
    """Mix a mono (panned) or stereo signal into a (2, n) buffer at time t."""
    i0 = int(round(t * SR))
    n = sig.shape[-1]
    a, b = max(i0, 0), min(i0 + n, buf.shape[1])
    if b <= a:
        return
    s = sig[..., a - i0 : b - i0]
    if sig.ndim == 1:
        gl, gr = pan_gains(pan)
        buf[0, a:b] += s * (gain * gl)
        buf[1, a:b] += s * (gain * gr)
    else:
        buf[:, a:b] += s * gain


def make_ir(dur=2.8, t60=2.4, predelay=0.022, lp_hz=7500, seed=7):
    """Stereo synthetic reverb impulse response: decorrelated decaying noise with
    a faster-decaying bright band (frequency-dependent decay), unit energy."""
    rng = np.random.default_rng(seed)
    n = int(dur * SR)
    t = tvec(n)
    pre = int(predelay * SR)
    ir = np.zeros((2, n + pre))
    for c in range(2):
        noise = rng.standard_normal(n)
        bright = lp(noise, lp_hz, 2) * np.exp(-6.91 * t / (t60 * 0.45))
        dark = lp(noise, lp_hz * 0.3, 2) * np.exp(-6.91 * t / t60)
        body = 0.55 * bright + dark
        body *= 1.0 - np.exp(-t / 0.012)  # soft onset = diffuse build-up
        body *= tail_fade(n, 0.25)
        ir[c, pre:] = body
    ir /= np.sqrt(np.sum(ir**2, axis=1, keepdims=True))
    return ir


def convolve_reverb(x, ir):
    """x: (2, n) send; returns (2, n) wet (mono-summed send into stereo IR)."""
    mono = 0.5 * (x[0] + x[1])
    n = x.shape[1]
    wet = np.vstack(
        [signal.oaconvolve(mono, ir[0])[:n], signal.oaconvolve(mono, ir[1])[:n]]
    )
    return wet


def kweight_lufs(x):
    """Approximate integrated loudness (ITU-R BS.1770: K-weighting + gating)."""
    fs = SR
    # high shelf (RBJ), +4 dB @ 1500 Hz
    A = 10 ** (4.0 / 40)
    w0 = 2 * np.pi * 1500 / fs
    al = np.sin(w0) / (2 * (1 / np.sqrt(2)))
    cw = np.cos(w0)
    b = [
        A * ((A + 1) + (A - 1) * cw + 2 * np.sqrt(A) * al),
        -2 * A * ((A - 1) + (A + 1) * cw),
        A * ((A + 1) + (A - 1) * cw - 2 * np.sqrt(A) * al),
    ]
    a = [
        (A + 1) - (A - 1) * cw + 2 * np.sqrt(A) * al,
        2 * ((A - 1) - (A + 1) * cw),
        (A + 1) - (A - 1) * cw - 2 * np.sqrt(A) * al,
    ]
    y = signal.lfilter(b, a, x, axis=-1)
    w0 = 2 * np.pi * 38 / fs
    al = np.sin(w0) / (2 * 0.5)
    cw = np.cos(w0)
    b = [(1 + cw) / 2, -(1 + cw), (1 + cw) / 2]
    a = [1 + al, -2 * cw, 1 - al]
    y = signal.lfilter(b, a, y, axis=-1)
    blk, hop = int(0.4 * fs), int(0.1 * fs)
    cs = np.concatenate([[0.0], np.cumsum(np.sum(y**2, axis=0))])
    starts = np.arange(0, y.shape[1] - blk, hop)
    z = (cs[starts + blk] - cs[starts]) / blk
    lk = -0.691 + 10 * np.log10(np.maximum(z, 1e-20))
    z1 = z[lk > -70]
    if len(z1) == 0:
        return -99.0
    rel = -0.691 + 10 * np.log10(np.mean(z1)) - 10
    z2 = z[(lk > -70) & (lk > rel)]
    return -0.691 + 10 * np.log10(np.mean(z2))


def limiter(x, ceiling_db=-6.0, hold=0.05, smooth=0.025):
    """Look-ahead peak limiter (zero-phase min-hold + moving average on gain),
    followed by a soft clipper just under the ceiling."""
    c = 10 ** (ceiling_db / 20)
    peak = np.max(np.abs(x), axis=0)
    g = np.minimum(1.0, (c * 0.98) / np.maximum(peak, 1e-9))
    h = int(hold * SR) | 1
    s = int(smooth * SR) | 1
    g = minimum_filter1d(g, size=h, mode="nearest")
    g = uniform_filter1d(g, size=s, mode="nearest")
    y = x * g
    k = c * 0.9
    ay = np.abs(y)
    over = ay > k
    y[over] = np.sign(y[over]) * (k + (c - k) * np.tanh((ay[over] - k) / (c - k)))
    return y, g


def normalize_peak(x, peak_db=-3.0):
    return x * (10 ** (peak_db / 20) / np.max(np.abs(x)))


def to_int16(x):
    return np.round(np.clip(x, -1.0, 1.0) * 32767.0).astype(np.int16).T.copy()


def write_wav(name, x):
    path = os.path.join(OUT_DIR, name)
    wavfile.write(path, SR, to_int16(x))
    return path


# --------------------------------------------------------------------------
# Instruments (mono one-shots unless stated)
# --------------------------------------------------------------------------


def kick(dur=0.5, rng=None):
    n = int(dur * SR)
    t = tvec(n)
    f = 50 + (155 - 50) * np.exp(-t / 0.032)
    ph = 2 * np.pi * np.cumsum(f) / SR
    body = np.sin(ph) * (1 - np.exp(-t / 0.0008)) * np.exp(-t / 0.26)
    click = lp(rng.standard_normal(n), 2500) * np.exp(-t / 0.0025) * 0.25
    y = np.tanh(1.6 * (body + click)) / np.tanh(1.6)
    return y * tail_fade(n, 0.03)


def clap(dur=0.45, rng=None):
    n = int(dur * SR)
    t = tvec(n)
    noise = bp(rng.standard_normal(n), 950, 3600, 2)
    env = np.zeros(n)
    for ti, g in ((0.0, 0.75), (0.011, 0.85), (0.022, 0.95)):
        m = t >= ti
        env[m] += g * np.exp(-(t[m] - ti) / 0.0045)
    m = t >= 0.031
    env[m] += 0.9 * np.exp(-(t[m] - 0.031) / 0.12)
    f = 185 * (1 + 0.15 * np.exp(-t / 0.01))
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.045) * 0.35
    y = noise * env / np.max(np.abs(noise * env)) + body
    return y * tail_fade(n, 0.03)


def snare(dur=0.35, rng=None):
    n = int(dur * SR)
    t = tvec(n)
    noise = bp(rng.standard_normal(n), 1300, 7500, 2) * np.exp(-t / 0.085)
    noise /= np.max(np.abs(noise))
    f = 205 * (1 + 0.2 * np.exp(-t / 0.008))
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.055) * 0.55
    y = (noise + body) * (1 - np.exp(-t / 0.0006))
    return y * tail_fade(n, 0.03)


def hat(decay=0.035, dur=0.25, rng=None):
    n = int(dur * SR)
    t = tvec(n)
    noise = lp(hp(rng.standard_normal(n), 7200, 4), 13500, 2)
    y = noise * (1 - np.exp(-t / 0.0006)) * np.exp(-t / decay)
    return y / np.max(np.abs(y)) * tail_fade(n, 0.02)


def shaker(dur=0.16, rng=None):
    n = int(dur * SR)
    t = tvec(n)
    noise = bp(rng.standard_normal(n), 4500, 10500, 2)
    att = 0.014
    env = np.where(t < att, (t / att) ** 2, np.exp(-(t - att) / 0.045))
    y = noise * env
    return y / np.max(np.abs(y)) * tail_fade(n, 0.02)


def perc(f0, dur=0.25):
    n = int(dur * SR)
    t = tvec(n)
    f = f0 * (1 + 0.35 * np.exp(-t / 0.006))
    ph = 2 * np.pi * np.cumsum(f) / SR
    y = np.sin(ph + 0.6 * np.exp(-t / 0.01) * np.sin(2.7 * ph))
    y *= (1 - np.exp(-t / 0.0005)) * np.exp(-t / 0.06)
    return y * tail_fade(n, 0.02)


def crash(dur=3.0, decay=0.9, rng=None):
    n = int(dur * SR)
    t = tvec(n)
    noise = lp(hp(rng.standard_normal((2, n)), 3800, 2), 12000, 2)
    noise /= np.max(np.abs(noise))
    env = (1 - np.exp(-t / 0.003)) * np.exp(-t / decay)
    return noise * env * tail_fade(n, 0.2)


def reverse_swell(dur=1.0, rng=None):
    """Reversed-cymbal-like swell that resolves (ends) exactly at t = dur."""
    n = int(dur * SR)
    t = tvec(n)
    noise = lp(hp(rng.standard_normal((2, n)), 2500, 2), 11000, 2)
    noise /= np.max(np.abs(noise))
    env = np.exp((t - dur) / (dur * 0.22))
    env -= env[0]
    env /= env[-1]
    y = noise * env
    k = int(0.006 * SR)
    y[:, -k:] *= np.linspace(1, 0, k)
    return y


def sub_boom(dur=2.6, f0=95.0, f1=40.0, decay=0.75):
    n = int(dur * SR)
    t = tvec(n)
    f = f1 + (f0 - f1) * np.exp(-t / 0.11)
    ph = 2 * np.pi * np.cumsum(f) / SR
    y = np.sin(ph) * (1 - np.exp(-t / 0.002)) * np.exp(-t / decay)
    y = np.tanh(1.4 * y) / np.tanh(1.4)
    return y * tail_fade(n, 0.3)


def pluck(f, dur=0.6, bright=1.0, decay=0.17):
    """Glassy FM pluck: 2:1 FM with fast index decay + faint 3.5:1 glass partial."""
    n = int(dur * SR)
    t = tvec(n)
    w = 2 * np.pi * f * t
    idx = bright * (1.5 * np.exp(-t / 0.055) + 0.18)
    y = 0.82 * np.sin(w + idx * np.sin(2.0 * w))
    y += 0.18 * np.sin(w + 0.5 * bright * np.exp(-t / 0.03) * np.sin(3.5 * w))
    y *= (1 - np.exp(-t / 0.0015)) * np.exp(-t / decay)
    return y * tail_fade(n, 0.03)


def mallet(f, dur=1.2, decay=0.45):
    """Countermelody: soft glass mallet (1:1 FM body + inharmonic 4.0 glass partial)."""
    n = int(dur * SR)
    t = tvec(n)
    w = 2 * np.pi * f * t
    vib = 1 + 0.0025 * np.sin(2 * np.pi * 5.2 * t) * (1 - np.exp(-t / 0.25))
    w = 2 * np.pi * f * np.cumsum(vib) / SR
    y = np.sin(w + 0.9 * np.exp(-t / 0.12) * np.sin(w))
    y += 0.22 * np.sin(4.0 * w) * np.exp(-t / 0.07)
    y *= (1 - np.exp(-t / 0.003)) * np.exp(-t / decay)
    return y * tail_fade(n, 0.05)


def bell(f, dur=4.0, decay=1.8):
    """FM bell: 3.5:1 inharmonic modulator with decaying index + pure sine body."""
    n = int(dur * SR)
    t = tvec(n)
    w = 2 * np.pi * f * t
    idx = 2.2 * np.exp(-t / 0.35) + 0.15
    y = 0.6 * np.sin(w + idx * np.sin(3.5 * w)) * np.exp(-t / decay)
    y += 0.45 * np.sin(w) * np.exp(-t / (decay * 1.4))
    y += 0.12 * np.sin(2.0 * w) * np.exp(-t / (decay * 0.5))
    y *= 1 - np.exp(-t / 0.002)
    return y * tail_fade(n, 0.3)


def bass_note(f, dur, rel=0.03):
    n = int((dur + rel) * SR)
    t = tvec(n)
    ph = 2 * np.pi * f * t
    y = np.sin(ph) + 0.22 * np.sin(2 * ph) + 0.05 * np.sin(3 * ph)
    env = np.minimum(1.0, t / 0.004) * (0.78 + 0.22 * np.exp(-t / 0.09))
    m = t > dur
    env[m] *= np.maximum(0.0, 1 - (t[m] - dur) / rel)
    y = np.tanh(1.3 * y * env) / np.tanh(1.3)
    return y


def pad_note(f, length, attack, release, rng, sustain=0.85):
    """Warm detuned polyBLEP saw stack, returns stereo (2, n)."""
    n = int((length + release) * SR)
    t = tvec(n)
    dpt = min(attack + 0.4, max(length, attack + 0.01))
    env = np.interp(
        t,
        [0, attack, dpt, max(length, dpt + 1e-3), length + release],
        [0, 1, sustain, sustain, 0],
    )
    out = np.zeros((2, n))
    for det, p in ((-11, -0.8), (-4, -0.3), (4, 0.3), (11, 0.8)):
        s = saw_blep(f * 2 ** (det / 1200), n, rng.random())
        gl, gr = pan_gains(p)
        out[0] += s * gl
        out[1] += s * gr
    body = np.sin(2 * np.pi * f * t + rng.random() * 6.28) * 0.9
    out += body * 0.707
    return out * env


# --------------------------------------------------------------------------
# Harmony & arrangement data
# --------------------------------------------------------------------------

CHORDS = {
    "F": dict(pad=[53, 57, 60, 64, 67], arp=[65, 69, 72, 76, 79], root=41),  # Fmaj9
    "Em": dict(pad=[52, 55, 59, 62, 67], arp=[64, 67, 71, 74, 79], root=40),  # Em7
    "Dm": dict(pad=[50, 53, 57, 60, 64], arp=[62, 65, 69, 72, 76], root=38),  # Dm9
    "G": dict(pad=[50, 55, 60, 64, 67], arp=[62, 67, 72, 74, 76], root=43),  # G6sus
    "C": dict(pad=[48, 55, 59, 62, 64, 67], arp=[72, 76, 79, 83, 86], root=36),  # Cmaj9
}
LOOP = ["F", "Em", "Dm", "G"]

ARP_A = list(zip(range(0, 16, 2), [0, 2, 4, 2, 1, 3, 4, 3]))
ARP_B = list(enumerate([0, 1, 2, 4, 2, 3, 4, 1, 0, 2, 3, 4, 3, 2, 1, 2]))
ARP_C = list(enumerate([4, 2, 0, 2, 3, 1, 4, 1, 4, 2, 0, 3, 2, 4, 1, 3]))

BASS_A = [(0, 4, 0), (6, 2, 0), (8, 4, 0), (11, 1, 0), (14, 2, 0)]
BASS_B = [(0, 3, 0), (3, 2, 0), (6, 2, 12), (8, 3, 0), (11, 2, 0), (14, 2, 12)]

# countermelody per loop position: (step, length in steps, midi)
MEL = {
    0: [(0, 6, 76), (6, 2, 79), (8, 8, 81)],
    1: [(0, 6, 79), (6, 2, 76), (8, 8, 74)],
    2: [(0, 4, 77), (4, 4, 76), (8, 4, 74), (12, 4, 72)],
    3: [(0, 6, 74), (6, 2, 76), (8, 8, 79)],
}


def bt(bar, step=0.0):
    return bar * BAR + step * STEP


def swing(step):
    return SWING if step % 2 == 1 else 0.0


def section(bar):
    if bar < 4:
        return "intro"
    if bar < 12:
        return "A"
    if bar < 20:
        return "B"
    if bar < 25:
        return "C"
    if bar < 27:
        return "lift"
    if bar < 29:
        return "B2"
    if bar < 37:
        return "D1"
    return "D2"


GROOVE_BARS = range(4, 44)  # 8.0 .. 88.0


# --------------------------------------------------------------------------
# Music
# --------------------------------------------------------------------------


def render_music():
    t_start = time.time()
    rng = np.random.default_rng(20261011)
    T = np.arange(N) / SR
    REF = (int(58 * SR), int(86 * SR))  # all layers active here

    mix = np.zeros((2, N))
    rev = np.zeros((2, N))
    dly = np.zeros((2, N))

    def curve(points, log=False):
        ts, vs = zip(*points)
        if log:
            return np.exp(np.interp(T, ts, np.log(vs)))
        return np.interp(T, ts, vs)

    def commit(name, bus, rms_db=None, peak_db=None, rev_send=0.0, dly_send=0.0):
        if rms_db is not None:
            seg = bus[:, REF[0] : REF[1]]
            r = np.sqrt(np.mean(seg**2))
            bus *= 10 ** (rms_db / 20) / max(r, 1e-12)
        elif peak_db is not None:
            bus *= 10 ** (peak_db / 20) / max(np.max(np.abs(bus)), 1e-12)
        np.add(mix, bus, out=mix)
        if rev_send:
            np.add(rev, bus * rev_send, out=rev)
        if dly_send:
            np.add(dly, bus * dly_send, out=dly)
        print(f"  layer {name:<8} peak {dbfs(np.max(np.abs(bus))):6.1f} dB")

    # ---- kick times & sidechain -------------------------------------------
    kick_times, ghost_times = [], []
    for bar in GROOVE_BARS:
        if section(bar) == "lift":
            continue
        for s in (0, 4, 8, 12):
            kick_times.append(bt(bar, s))
        if bar >= 29 and bar % 2 == 1 and bar != 43:
            ghost_times.append(bt(bar, 14))

    marks = np.full(N, -(10**9), dtype=np.int64)
    for kt in kick_times:
        i = int(round(kt * SR))
        marks[i] = i
    last = np.maximum.accumulate(marks)
    ts = (np.arange(N) - last) / SR
    x = np.clip((ts - 0.004) / 0.24, 0, 1)
    duck_shape = np.minimum(ts / 0.004, 1.0) * (1 - (3 * x**2 - 2 * x**3))
    del marks, last, ts, x

    def sidechain(depth):
        return 1.0 - depth * duck_shape

    # ---- PADS ---------------------------------------------------------------
    pad = np.zeros((2, N))
    events = []
    for bar in range(0, 44):
        length = 2.5 if bar == 43 else BAR  # G holds until the final hit at 88.5
        atk = 1.4 if bar == 0 else (0.25 if bar < 4 else 0.035)
        events.append((bt(bar), length, CHORDS[LOOP[bar % 4]]["pad"], atk, 0.3))
    events.append((88.5, 3.2, CHORDS["C"]["pad"], 0.012, 2.8))
    for start, length, notes, atk, rel in events:
        for m in notes:
            add(pad, start, pad_note(mtof(m), length, atk, rel, rng), 0.05)
    pad_cut = curve(
        [(0, 260), (4, 650), (6, 1300), (7.95, 2700), (8.0, 3000), (50, 3000),
         (52, 4600), (53.99, 5000), (54.0, 3200), (58, 3600), (86, 3700),
         (88.0, 4200), (88.46, 700), (88.5, 5500), (94.5, 1300)],
        log=True,
    )
    pad = tv_filter(pad, pad_cut, "low", block=256)
    pad = hp(pad, 110, 2)  # leave the low end to the bass
    pad *= sidechain(0.35)
    pad *= curve(
        [(0, 0.0), (2.0, 0.55), (7.95, 0.85), (8.0, 1.0), (50, 1.0), (50.6, 1.15),
         (53.9, 1.15), (54.0, 1.0), (88.0, 1.0), (88.3, 0.3), (88.46, 0.3), (88.5, 2.0), (94.5, 2.0)]
    )
    # gentle tape-style saturation relative to the groove level: tames the crest
    # of the big final chord so the master limiter doesn't flatten the hit
    r = np.sqrt(np.mean(pad[:, REF[0] : REF[1]] ** 2))
    pad = 7.0 * r * np.tanh(pad / (7.0 * r))
    commit("pad", pad, rms_db=-23.0, rev_send=0.28)
    del pad

    # ---- BASS (mono) --------------------------------------------------------
    bass = np.zeros((2, N))
    for bar in GROOVE_BARS:
        sec = section(bar)
        root = mtof(CHORDS[LOOP[bar % 4]]["root"])
        if sec == "lift":
            add(bass, bt(bar), lp(bass_note(root, BAR - 0.05, 0.05), 400), 0.8)
            continue
        pattern = BASS_A if sec == "A" else BASS_B
        for s, ln, semi in pattern:
            vel = 1.0 if s in (0, 8) else 0.85
            add(bass, bt(bar, s), bass_note(root * 2 ** (semi / 12), ln * STEP * 0.9), vel)
    add(bass, 88.5, bass_note(mtof(36), 4.5, 1.5) * np.exp(-tvec(int(6.0 * SR)) / 1.8), 1.0)
    bass = lp(bass, 900, 2)
    bass *= sidechain(0.3)
    commit("bass", bass, rms_db=-21.0)
    del bass

    # ---- KICK ----------------------------------------------------------------
    kick_s = kick(rng=rng)
    kbus = np.zeros((2, N))
    for kt in kick_times:
        add(kbus, kt, kick_s, 1.0)
    for kt in ghost_times:
        add(kbus, kt, kick_s, 0.45)
    for bar in (2, 3):  # muffled heartbeat in the intro
        for s in (0, 8):
            add(kbus, bt(bar, s), lp(kick_s, 300), 0.3 + 0.1 * (bar - 2))
    commit("kick", kbus, rms_db=-19.0)
    del kbus

    # ---- CLAP / SNARE ----------------------------------------------------------
    clap_s = clap(rng=rng)
    snare_s = snare(rng=rng)
    cbus = np.zeros((2, N))
    for bar in GROOVE_BARS:
        for s in (4, 12):
            if bar == 26 and s == 12:
                continue  # fill takes over
            g = 0.75 if section(bar) == "lift" else 1.0
            add(cbus, bt(bar, s), clap_s, g, pan=0.05)
    # fill 53.0-54.0: 16ths then 32nds, crescendo
    fill = [53.0 + i * STEP for i in range(4)] + [53.5 + i * STEP / 2 for i in range(8)]
    for i, ft in enumerate(fill):
        add(cbus, ft, snare_s, 0.35 + 0.6 * i / (len(fill) - 1), pan=(-0.2 if i % 2 else 0.2))
    # build 86.0-88.0: 8ths, 16ths, 32nds, then a half-beat breath before the hit
    roll = [86.0 + i * 2 * STEP for i in range(8)] + [87.0 + i * STEP for i in range(4)]
    roll += [87.5 + i * STEP / 2 for i in range(8)] + [88.0]
    for i, rt in enumerate(roll):
        add(cbus, rt, snare_s, 0.25 + 0.75 * (i / (len(roll) - 1)) ** 1.5,
            pan=(-0.15 if i % 2 else 0.15))
    commit("clap", cbus, rms_db=-32.0, rev_send=0.3)
    del cbus

    # ---- HATS --------------------------------------------------------------------
    hats = [hat(rng=rng) for _ in range(4)]
    ohat = hat(decay=0.16, dur=0.5, rng=rng)
    hbus = np.zeros((2, N))
    vel16 = [0.38, 0.2, 0.75, 0.24]

    def hit(bar, s, g, open_=False):
        smp = ohat if open_ else hats[(bar * 16 + s) % 4]
        add(hbus, bt(bar, s) + swing(s), smp, g, pan=-0.25)

    for bar in range(2, 44):
        sec = section(bar)
        for s in range(16):
            if bar == 43 and s >= 16:
                continue
            if sec == "intro":
                if bar == 2 and s % 2 == 0:
                    hit(bar, s, 0.25 + 0.15 * (s % 4 == 2))
                elif bar == 3:
                    hit(bar, s, (0.2 + 0.35 * s / 15) * (1.0 if s % 2 == 0 else 0.6))
            elif sec == "A":
                if s % 2 == 0:
                    hit(bar, s, 0.8 if s % 4 == 2 else 0.35)
            elif sec in ("B", "B2", "D1"):
                hit(bar, s, vel16[s % 4])
                if sec == "D1" and s == 14:
                    hit(bar, s, 0.45, open_=True)
            elif sec in ("C", "D2"):
                if s % 4 == 2:
                    hit(bar, s, 0.5, open_=True)
                else:
                    hit(bar, s, 0.22 if s % 2 else 0.32)
            elif sec == "lift":
                if s % 2 == 0 and not (bar == 26 and s >= 8):
                    hit(bar, s, 0.45 if s % 4 == 2 else 0.25)
    commit("hats", hbus, rms_db=-33.0, rev_send=0.06)
    del hbus

    # ---- SHAKER + PERC -----------------------------------------------------------
    shakers = [shaker(rng=rng) for _ in range(4)]
    sbus = np.zeros((2, N))
    for bar in GROOVE_BARS:
        sec = section(bar)
        if sec in ("intro", "A", "lift"):
            continue
        g = 1.0 if sec in ("D1", "D2") else 0.7
        for s in range(16):
            v = [0.35, 0.55, 0.45, 0.75][s % 4]
            add(sbus, bt(bar, s) + swing(s) + 0.004, shakers[s % 4], v * g, pan=0.45)
    commit("shaker", sbus, rms_db=-37.0, rev_send=0.08)
    del sbus

    perc_hi, perc_lo = perc(610), perc(430)
    pbus = np.zeros((2, N))
    for bar in range(29, 43):
        for s, smp, p in ((3, perc_hi, 0.45), (7, perc_lo, -0.45), (10, perc_hi, 0.45),
                          (13, perc_lo, -0.45)):
            if s == 13 and bar % 2 == 0:
                continue
            add(pbus, bt(bar, s) + swing(s), smp, 0.8 if s in (3, 10) else 0.6, pan=p)
    commit("perc", pbus, rms_db=-35.0, rev_send=0.2)
    del pbus

    # ---- ARPS ----------------------------------------------------------------------
    abus = np.zeros((2, N))
    obus = np.zeros((2, N))
    pluck_cache = {}

    def get_pluck(m, bright, decay=0.17):
        key = (m, round(bright, 2), decay)
        if key not in pluck_cache:
            pluck_cache[key] = pluck(mtof(m), 0.7, bright, decay)
        return pluck_cache[key]

    for bar in range(2, 44):
        sec = section(bar)
        tones = CHORDS[LOOP[bar % 4]]["arp"]
        if sec == "intro":
            pat, bright, gain = ARP_A, 0.35, 0.25 + 0.35 * (bar - 2)
        elif sec == "A":
            pat, bright, gain = ARP_A, 0.9, 1.0
        elif sec in ("B", "B2", "D1"):
            pat, bright, gain = ARP_B, 0.9, 0.85
        elif sec in ("C", "D2"):
            pat, bright, gain = ARP_C, 1.0, 0.85
        else:  # lift
            pat, bright, gain = ARP_A, 1.2, 1.0
        for s, i in pat:
            vel = 1.0 if s % 4 == 0 else (0.75 if s % 2 == 0 else 0.55)
            p = -0.35 + 0.7 * (i / 4)
            add(abus, bt(bar, s) + swing(s), get_pluck(tones[i], bright), gain * vel, pan=p)
        if sec in ("D1", "D2"):
            for s, i in ARP_A:
                add(obus, bt(bar, s) + swing(s), get_pluck(tones[i] + 12, 0.7, 0.12),
                    0.75 if s % 4 == 0 else 0.5, pan=0.5 - 0.25 * (i / 4))
    abus = lp(abus, 7000, 2)
    abus *= sidechain(0.18)
    commit("arp", abus, rms_db=-27.0, rev_send=0.3, dly_send=0.35)
    del abus
    obus = lp(obus, 8000, 2)
    commit("arp8va", obus, rms_db=-34.0, rev_send=0.35, dly_send=0.4)
    del obus

    # ---- COUNTERMELODY -------------------------------------------------------------
    mbus = np.zeros((2, N))
    for bar in list(range(12, 20)) + list(range(29, 44)):
        for s, ln, m in MEL[bar % 4]:
            dec = max(0.3, ln * STEP * 0.8)
            add(mbus, bt(bar, s), mallet(mtof(m), 1.6, dec), 1.0, pan=0.15)
            if section(bar) == "D2":
                add(mbus, bt(bar, s) + 0.01, mallet(mtof(m + 12), 1.0, dec * 0.6), 0.25,
                    pan=-0.3)
    commit("melody", mbus, rms_db=-28.0, rev_send=0.45, dly_send=0.25)
    del mbus

    # ---- INTRO TICK ------------------------------------------------------------------
    tbus = np.zeros((2, N))
    tick_hi = pluck(mtof(91), 0.25, 0.6, 0.035)
    tick_lo = pluck(mtof(86), 0.25, 0.6, 0.035)
    for bar in range(4):
        steps = range(16) if bar == 3 else range(0, 16, 2)
        for s in steps:
            tt = bt(bar, s)
            g = 0.55 + 0.45 * tt / 8.0
            if bar == 3 and s % 2:
                g *= 0.55
            add(tbus, tt, tick_hi if s % 4 == 0 else tick_lo, g,
                pan=0.35 if (s // 2) % 2 else -0.35)
    commit("tick", tbus, peak_db=-17.0, rev_send=0.35, dly_send=0.15)
    del tbus

    # ---- FX: risers, swells, impacts, bells --------------------------------------------
    fx = np.zeros((2, N))

    def noise_riser(dur, f0, f1, power=2.2):
        n = int(dur * SR)
        t = tvec(n)
        nz = rng.standard_normal((2, n))
        cut = f0 * (f1 / f0) ** (t / dur)
        y = tv_filter(nz, cut, "low", block=256)
        y /= np.max(np.abs(y))
        y *= (t / dur) ** power
        k = int(0.012 * SR)
        y[:, -k:] *= np.linspace(1, 0, k)
        return y

    def tone_riser(dur, m0, m1):
        n = int(dur * SR)
        t = tvec(n)
        f = mtof(m0) * 2 ** ((m1 - m0) / 12 * (t / dur) ** 1.4)
        y = np.zeros((2, n))
        for det, p in ((-9, -0.7), (0, 0.0), (9, 0.7)):
            s = lp(saw_blep(f * 2 ** (det / 1200), n, rng.random()), 2600, 2)
            gl, gr = pan_gains(p)
            y[0] += s * gl
            y[1] += s * gr
        y /= np.max(np.abs(y))
        y *= (t / dur) ** 2.0
        k = int(0.012 * SR)
        y[:, -k:] *= np.linspace(1, 0, k)
        return y

    # intro riser 6.0-8.0
    add(fx, 6.0, noise_riser(2.0, 300, 9000), 0.32)
    add(fx, 6.0, tone_riser(2.0, 55, 79), 0.16)
    add(fx, 6.5, reverse_swell(1.5, rng), 0.3)
    # DROP at 8.0
    add(fx, 8.0, sub_boom(), 0.95)
    add(fx, 8.0, crash(3.0, 0.9, rng), 0.22)
    for i, m in enumerate([77, 81, 84, 88, 91]):
        add(fx, 8.0 + i * 0.012, bell(mtof(m), 4.0, 1.6), 0.14, pan=-0.6 + 0.3 * i)
    # section transition swells + light crashes
    for tt in (24.0, 40.0, 58.0, 74.0):
        add(fx, tt - 1.0, reverse_swell(1.0, rng), 0.14)
        add(fx, tt, crash(2.5, 0.6, rng), 0.09)
    add(fx, 53.0, reverse_swell(1.0, rng), 0.2)
    add(fx, 54.0, crash(2.5, 0.8, rng), 0.14)
    add(fx, 54.0, sub_boom(1.6, 80, 40, 0.35), 0.4)
    # build 86.0-88.0, then a quiet reverse swell sucks into the hit at 88.5
    add(fx, 86.0, noise_riser(2.0, 400, 10000, 2.6), 0.3)
    add(fx, 86.0, tone_riser(2.0, 55, 79), 0.12)
    add(fx, 87.7, reverse_swell(0.8, rng), 0.08)
    # FINAL HIT at 88.5
    add(fx, 88.5, sub_boom(5.0, 100, 40, 1.1), 0.5)
    add(fx, 88.5, crash(5.5, 1.6, rng), 0.3)
    for i, m in enumerate([72, 76, 79, 83, 86, 91]):
        add(fx, 88.5 + i * 0.01, bell(mtof(m), 6.0, 2.2), 0.19, pan=-0.6 + 0.24 * i)
    cascade = [96, 95, 91, 88, 86, 84, 83, 79, 76, 72]
    for i, m in enumerate(cascade):
        add(fx, 88.75 + i * STEP, pluck(mtof(m), 1.2, 0.8, 0.35), 0.09 * (1 - i / 14),
            pan=0.6 if i % 2 else -0.6)
    commit("fx", fx, peak_db=-5.0, rev_send=0.4, dly_send=0.08)
    del fx

    # ---- DELAY (ping-pong, dotted 8th) -------------------------------------------------
    d = int(round(0.375 * SR))
    dm = 0.5 * (dly[0] + dly[1])
    wet = np.zeros((2, N))
    for k in range(1, 7):
        g = 0.42**k
        ch = 0 if k % 2 else 1
        wet[ch, k * d :] += dm[: N - k * d] * g
    wet = lp(hp(wet, 350, 2), 4500, 2)
    np.add(mix, wet * 0.8, out=mix)
    np.add(rev, wet * 0.3, out=rev)
    del dly, wet, dm

    # ---- REVERB -----------------------------------------------------------------------
    rev = lp(hp(rev, 250, 2), 9000, 2)
    ir = make_ir(3.2, 2.6, 0.025, 7000, seed=3)
    wet = convolve_reverb(rev, ir)
    np.add(mix, wet * 0.55, out=mix)
    del rev, wet

    # ---- MASTER -------------------------------------------------------------------------
    mix = hp(mix, 28, 2)  # DC / sub rumble below the kick
    mid = 0.5 * (mix[0] + mix[1])
    side = hp(0.5 * (mix[0] - mix[1]), 140, 2)  # mono lows
    mix = np.vstack([mid + side, mid - side])
    del mid, side

    # end: chord + bells ring out, fade to true silence by 94.5
    mix *= curve([(0, 1.0), (90.5, 1.0), (94.5, 0.0)]) ** 1.6
    pre_lufs = kweight_lufs(mix)
    target = -14.6
    mix *= 10 ** ((target - pre_lufs) / 20)
    mix, g = limiter(mix, ceiling_db=-6.0)
    gr = -20 * np.log10(g)
    for tt in (8.0, 8.2, 30.0, 88.5, 88.8, 90.0):
        print(f"  limiter GR at {tt:5.1f}s: {gr[int(tt * SR)]:.1f} dB")
    print(f"  limiter: max GR {gr.max():.1f} dB, >1 dB {100 * np.mean(gr > 1):.1f}% of time,"
          f" >3 dB {100 * np.mean(gr > 3):.1f}%")
    fade_edges(mix, 0.005)
    mix[:, -int(0.01 * SR) :] = 0.0
    assert mix.shape == (2, N)
    print(f"  music rendered in {time.time() - t_start:.1f}s")
    return mix


# --------------------------------------------------------------------------
# Sound effects
# --------------------------------------------------------------------------


def stereo(x, width=0.0):
    return np.vstack([x, x])


def sfx_send(rng):
    dur = 0.26
    n = int(dur * SR)
    t = tvec(n)
    f = 360 * (1150 / 360) ** (np.clip(t / 0.2, 0, 1) ** 0.85)
    ph = 2 * np.pi * np.cumsum(f) / SR
    tone = np.sin(ph) + 0.12 * np.sin(2 * ph)
    att = 0.035
    env = np.where(t < att, 0.5 - 0.5 * np.cos(np.pi * t / att), np.exp(-(t - att) / 0.065))
    tone = lp(tone * env, 5000, 2)
    nz = rng.standard_normal((2, n))
    cut = 1400 * (5200 / 1400) ** np.clip(t / 0.2, 0, 1)
    air = lp(tv_filter(nz, cut, "band", block=128, bw=1.5, order=2), 9000, 2)
    air /= np.max(np.abs(air))
    air *= env * 0.22
    y = stereo(tone) + air
    return y


def sfx_receive(rng):
    dur = 0.3
    n = int(dur * SR)
    t = tvec(n)
    y = np.zeros((2, n))
    for t0, f0, g, p in ((0.0, 880.0, 1.0, -0.12), (0.068, 1318.5, 0.8, 0.12)):
        m = int(t0 * SR)
        tt = t[: n - m]
        f = f0 * (1 - 0.05 * np.exp(-tt / 0.012))  # tiny upward "bubble" glide
        ph = 2 * np.pi * np.cumsum(f) / SR
        note = np.sin(ph) * np.exp(-tt / 0.07)
        note += 0.08 * np.sin(3.93 * ph) * np.exp(-tt / 0.016)  # marimba overtone
        note *= 1 - np.exp(-tt / 0.0028)
        gl, gr = pan_gains(p)
        y[0, m:] += note * g * gl
        y[1, m:] += note * g * gr
    return lp(y, 6000, 2)


def sfx_whoosh(rng):
    dur = 0.7
    n = int(dur * SR)
    t = tvec(n)
    common = rng.standard_normal(n)
    nz = np.vstack([common + 0.45 * rng.standard_normal(n), common + 0.45 * rng.standard_normal(n)])
    u = t / dur
    # centre frequency: smooth rise to a peak around 0.55, then falls back
    cut = 350 * (3600 / 350) ** np.sin(np.pi * np.clip(u / 1.1, 0, 1)) ** 1.5
    y = lp(tv_filter(nz, cut, "band", block=128, bw=1.6, order=2), 9000, 2)
    env = np.sin(np.pi * u ** 0.85) ** 2
    pan = np.clip(-0.7 + 1.4 * u, -1, 1)
    gl, gr = pan_gains(pan)
    y[0] *= env * gl
    y[1] *= env * gr
    return y


def sfx_ding(rng):
    dur = 1.2
    n = int(dur * SR)
    y = np.zeros((2, n))

    def chime(f, length):
        m = int(length * SR)
        t = tvec(m)
        w = 2 * np.pi * f * t
        x = np.sin(w + (1.1 * np.exp(-t / 0.09) + 0.05) * np.sin(2.0 * w))
        x += 0.25 * np.sin(w + 0.35 * np.exp(-t / 0.05) * np.sin(3.5 * w)) * np.exp(-t / 0.2)
        x += 0.15 * np.sin(2.0 * w) * np.exp(-t / 0.12)
        return x * (1 - np.exp(-t / 0.0015)) * np.exp(-t / 0.32)

    for t0, f, g, p in ((0.0, 1046.5, 0.85, -0.15), (0.085, 1568.0, 1.0, 0.15)):
        m = int(t0 * SR)
        c = chime(f, (n - m) / SR)[: n - m]
        gl, gr = pan_gains(p)
        y[0, m:] += c * g * gl
        y[1, m:] += c * g * gr
    ir = make_ir(1.0, 0.8, 0.012, 9000, seed=11)
    wet = np.vstack([signal.oaconvolve(y.mean(0), ir[0])[:n], signal.oaconvolve(y.mean(0), ir[1])[:n]])
    y = y + 0.18 * wet
    y *= tail_fade(n, 0.25)
    return y


def sfx_tap(rng):
    dur = 0.06
    n = int(dur * SR)
    t = tvec(n)
    x = np.sin(2 * np.pi * 1650 * t) * np.exp(-t / 0.006)
    x += 0.6 * np.sin(2 * np.pi * 320 * t) * np.exp(-t / 0.009)
    x += 0.25 * hp(rng.standard_normal(n), 2500, 2) * np.exp(-t / 0.0015)
    x *= 1 - np.exp(-t / 0.0004)
    return stereo(lp(x, 8000, 2))


def sfx_sparkle(rng):
    dur = 1.5
    n = int(dur * SR)
    t = tvec(n)
    y = np.zeros((2, n))
    pent = [2093.0, 2349.3, 2637.0, 3136.0, 3520.0, 4186.0, 4698.6]
    times = np.sort(1.05 * rng.random(26) ** 1.5)
    times[0] = 0.0
    for i, t0 in enumerate(times):
        f = pent[rng.integers(len(pent))] * (0.5 if rng.random() < 0.2 else 1.0)
        m = int(t0 * SR)
        tt = t[: n - m]
        dec = 0.08 + 0.22 * rng.random()
        ping = np.sin(2 * np.pi * f * tt + 0.5 * np.exp(-tt / 0.02) * np.sin(2 * np.pi * 3.5 * f * tt))
        ping += 0.2 * np.sin(2 * np.pi * 2.0 * f * tt) * np.exp(-tt / 0.04)
        ping *= (1 - np.exp(-tt / 0.001)) * np.exp(-tt / dec)
        amp = (0.55 + 0.45 * rng.random()) * (1 - 0.5 * t0 / 1.05)
        gl, gr = pan_gains(rng.uniform(-0.85, 0.85))
        y[0, m:] += ping * amp * gl
        y[1, m:] += ping * amp * gr
    shimmer = hp(rng.standard_normal((2, n)), 8000, 2)
    shimmer *= np.sin(np.pi * np.clip(t / 1.2, 0, 1)) ** 2 * 0.06
    y += shimmer
    ir = make_ir(1.4, 1.1, 0.015, 10000, seed=5)
    wet = np.vstack([signal.oaconvolve(y.mean(0), ir[0])[:n], signal.oaconvolve(y.mean(0), ir[1])[:n]])
    y = y + 0.3 * wet
    y *= tail_fade(n, 0.3)
    return lp(y, 12000, 2)


def sfx_riser(rng):
    dur = 2.0
    n = int(dur * SR)
    t = tvec(n)
    u = t / dur
    nz = rng.standard_normal((2, n))
    noise = tv_filter(nz, 300 * (12000 / 300) ** u, "low", block=256)
    noise /= np.max(np.abs(noise))
    f = 110 * 2 ** (3 * u**1.3)
    tone = np.zeros((2, n))
    for det, p in ((-12, -0.75), (0, 0.0), (12, 0.75)):
        s = lp(saw_blep(f * 2 ** (det / 1200), n, rng.random()), 4200, 2)
        s += 0.5 * np.sin(2 * np.pi * np.cumsum(2 * f) / SR)
        gl, gr = pan_gains(p)
        tone[0] += s * gl
        tone[1] += s * gr
    tone /= np.max(np.abs(tone))
    rate = 4 + 14 * u**1.5
    trem = 1 - 0.3 * u * (0.5 + 0.5 * np.sin(2 * np.pi * np.cumsum(rate) / SR))
    y = (0.6 * noise + 0.5 * tone) * trem * u**2.3
    return y


def finish_sfx(y, peak_db=-3.0):
    y = hp(y, 30, 2)
    y = y - y.mean(axis=1, keepdims=True)
    y = fade_edges(y, 0.005)
    return normalize_peak(y, peak_db)


# --------------------------------------------------------------------------
# Verification
# --------------------------------------------------------------------------


def read_back(path):
    sr, d = wavfile.read(path)
    assert sr == SR, (path, sr)
    assert d.dtype == np.int16 and d.ndim == 2 and d.shape[1] == 2, (path, d.dtype, d.shape)
    return d.T.astype(np.float64) / 32768.0, d


def report(paths):
    print("\n== File stats ==")
    print(f"{'file':<13}{'dur (s)':>9}{'peak dBFS':>11}{'RMS dBFS':>10}{'DC':>10}{'clipped':>9}")
    for p in paths:
        x, raw = read_back(p)
        peak = np.max(np.abs(x))
        rms = np.sqrt(np.mean(x**2))
        clipped = int(np.sum(np.abs(raw.astype(np.int32)) >= 32767))
        print(f"{os.path.basename(p):<13}{x.shape[1] / SR:9.3f}{dbfs(peak):11.2f}"
              f"{dbfs(rms):10.2f}{np.mean(x):10.6f}{clipped:9d}")

    x, raw = read_back(os.path.join(OUT_DIR, "music.wav"))
    assert x.shape[1] == N, f"music.wav is {x.shape[1]} samples, expected {N}"
    print(f"\nmusic.wav: {x.shape[1]} samples = {x.shape[1] / SR:.4f} s")
    print(f"approx integrated loudness (BS.1770 K-weighted, gated): {kweight_lufs(x):.1f} LUFS")
    act = x[:, int(8 * SR) : int(88 * SR)]
    print(f"RMS 8-88 s: {dbfs(np.sqrt(np.mean(act ** 2))):.1f} dBFS;"
          f" DC L/R: {np.mean(x[0]):.2e} / {np.mean(x[1]):.2e}")
    corr = np.corrcoef(lp(x[0], 120, 4), lp(x[1], 120, 4))[0, 1]
    print(f"low-end (<120 Hz) L/R correlation: {corr:.3f} (1.0 = mono)")

    print("\n== music.wav RMS per 2 s window ==")
    w = 2 * SR
    vals = []
    for i in range(int(np.ceil(N / w))):
        seg = x[:, i * w : min((i + 1) * w, N)]
        r = dbfs(np.sqrt(np.mean(seg**2)))
        vals.append(r)
        bar = "#" * max(0, int((r + 45) / 1.0))
        print(f"  {i * 2:5.1f}-{min((i + 1) * 2, DUR):5.1f}s {r:7.1f} dB  {bar}")

    def win(t0, t1):
        seg = x[:, int(t0 * SR) : int(t1 * SR)]
        return dbfs(np.sqrt(np.mean(seg**2)))

    print("\n== Transition checks (RMS, 0.5 s windows) ==")
    for name, tt in (("drop 8.0", 8.0), ("final hit 88.5", 88.5)):
        before, after = win(tt - 0.5, tt), win(tt, tt + 0.5)
        print(f"  {name}: before {before:.1f} dB -> after {after:.1f} dB (jump {after - before:+.1f} dB)")
    print(f"  intro 0-6 s: {win(0, 6):.1f} dB; groove 10-50: {win(10, 50):.1f} dB;"
          f" lift 50-54: {win(50, 54):.1f} dB; 58-86: {win(58, 86):.1f} dB;"
          f" tail 92-94.5: {win(92, 94.5):.1f} dB")
    print(f"  last 10 ms peak: {dbfs(np.max(np.abs(x[:, -441:]))):.1f} dBFS")


def main():
    t0 = time.time()
    os.makedirs(OUT_DIR, exist_ok=True)
    rng = np.random.default_rng(424242)
    paths = []
    print("Rendering music...")
    paths.append(write_wav("music.wav", render_music()))
    print("Rendering sfx...")
    for name, fn in (("send.wav", sfx_send), ("receive.wav", sfx_receive),
                     ("whoosh.wav", sfx_whoosh), ("ding.wav", sfx_ding), ("tap.wav", sfx_tap),
                     ("sparkle.wav", sfx_sparkle), ("riser.wav", sfx_riser)):
        paths.append(write_wav(name, finish_sfx(fn(rng))))
    report(paths)
    print(f"\nDone in {time.time() - t0:.1f}s -> {OUT_DIR}")


if __name__ == "__main__":
    main()
