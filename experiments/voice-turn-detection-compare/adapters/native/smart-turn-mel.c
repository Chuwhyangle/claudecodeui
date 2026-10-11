/*
 * smart-turn-mel.c — a COMPILED implementation of the Whisper log-mel front-end that group B's
 * Smart Turn analyser runs, as an N-API native addon (P0.6 / AC3).
 *
 * WHY. P0 located group B's decision latency (p90 167.4 ms, of which 128.5 ms was featurisation) in
 * the harness's OWN JavaScript log-mel front-end — a naive O(N^2) DFT (201 bins x 400 samples x 801
 * frames). The SPEC's claim was that a production build would replace it with a compiled/wasm mel
 * front-end. This file is that replacement, written in C, so the claim can be MEASURED rather than
 * asserted: the same recipe, the same input, three implementations (this one, the JS one, and the
 * P0.5 numpy oracle) compared numerically, then timed warm/cold.
 *
 * THE RECIPE (identical to `whisperLogMel` in ../smart-turn-v3.mts and to the numpy oracle):
 *   - input: mono float32 in [-1, 1]; take the LAST 8 s (left-pad with zeros if shorter)
 *   - reflect-pad by N_FFT/2 = 200 on both sides (numpy `mode='reflect'`, edge NOT repeated)
 *   - 400-point windowed frames at hop 160, periodic Hann (0.5 - 0.5 cos(2*pi*i/N))
 *   - rfft -> 201 power bins, per frame; the LAST frame is dropped (HF stft[..., :-1]) -> 800 frames
 *   - project onto an 80-filter slaney mel bank (0-8000 Hz, slaney area normalisation)
 *   - log10(max(x, 1e-10)) in double, cast to float32
 *   - max(x, max-8), then (x+4)/4  (the HF WhisperFeatureExtractor normalisation)
 *   - output float32 [80, 800] row-major (mel-major), exactly the JS layout
 *
 * THE FFT. A size-400 DFT done naively is what costs the 128.5 ms in JS. Here it is a Bluestein
 * chirp-z transform built on a 1024-point radix-2 FFT, so the featurisation is O(N log N) per frame
 * and the compiled path can be compared against the naive one on equal footing. Correctness against
 * numpy is verified numerically by the caller (see run.mts's compiled-feature check) before any
 * latency number is quoted.
 *
 * BUILD: gcc -O3 -shared -fPIC -I<node-headers> -o smart-turn-mel.node smart-turn-mel.c -lm
 * (see build.mjs; the addon exposes `melFeatures(Float32Array samples) -> Float32Array [80*800]`.)
 */
#include <node_api.h>
#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define N_FFT 400
#define HOP_LENGTH 160
#define N_MELS 80
#define SAMPLE_RATE 16000
#define WINDOW_SECONDS 8
#define N_SAMPLES (WINDOW_SECONDS * SAMPLE_RATE) /* 128000 */
#define N_FRAMES 800                             /* after the last frame is dropped */
#define PAD (N_FFT / 2)                          /* 200 */
#define MIN_LOG 1e-10

/* Bluestein working size: the smallest power of two >= 2*N_FFT - 1 = 799. */
#define BLUE_M 1024

/* ── radix-2 iterative FFT of size n (power of two), double precision ─────────────────────────── */

static void fft_pow2(double *re, double *im, int n, int inverse) {
  int i, j, k, len;
  /* bit-reversal permutation */
  for (i = 1, j = 0; i < n; i++) {
    int bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      double tr = re[i]; re[i] = re[j]; re[j] = tr;
      double ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (len = 2; len <= n; len <<= 1) {
    double ang = (inverse ? 2.0 : -2.0) * M_PI / (double)len;
    double wr = cos(ang), wi = sin(ang);
    for (i = 0; i < n; i += len) {
      double cr = 1.0, ci = 0.0;
      for (k = 0; k < len / 2; k++) {
        double ur = re[i + k], ui = im[i + k];
        double vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        double vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        double ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
  if (inverse) {
    for (i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }
}

/* ── Bluestein chirp-z: the 400-point DFT, using the BLUE_M radix-2 FFT ────────────────────────── */

static double blue_wr[BLUE_M], blue_wi[BLUE_M]; /* precomputed FFT of the chirp */
static double blue_chr[N_FFT], blue_chi[N_FFT]; /* chirp w[n] = exp(-i pi n^2 / N) */
static int blue_ready = 0;

static void bluestein_init(void) {
  if (blue_ready) return;
  /* a[n] = x[n] * w[n]; b[n] = conj(w[n]) placed circularly, both length BLUE_M */
  double *br = calloc(BLUE_M, sizeof(double)), *bi = calloc(BLUE_M, sizeof(double));
  for (int n = 0; n < N_FFT; n++) {
    double phase = M_PI * ((double)(((long long)n * n) % (2 * N_FFT))) / (double)N_FFT;
    blue_chr[n] = cos(phase);
    blue_chi[n] = -sin(phase); /* w[n] = e^{-i pi n^2 / N} */
    br[n] = blue_chr[n];
    bi[n] = -blue_chi[n]; /* conj(w[n]) */
    if (n > 0) {
      br[BLUE_M - n] = blue_chr[n];
      bi[BLUE_M - n] = -blue_chi[n];
    }
  }
  fft_pow2(br, bi, BLUE_M, 0);
  memcpy(blue_wr, br, sizeof(double) * BLUE_M);
  memcpy(blue_wi, bi, sizeof(double) * BLUE_M);
  free(br); free(bi);
  blue_ready = 1;
}

/* X[k] for k = 0..N_FFT-1, from real input xr (imag 0). */
static void dft400(const double *xr, double *Xr, double *Xi) {
  static double ar[BLUE_M], ai[BLUE_M];
  bluestein_init();
  memset(ar, 0, sizeof(double) * BLUE_M);
  memset(ai, 0, sizeof(double) * BLUE_M);
  for (int n = 0; n < N_FFT; n++) {
    /* a[n] = x[n] * w[n] */
    ar[n] = xr[n] * blue_chr[n];
    ai[n] = xr[n] * blue_chi[n];
  }
  fft_pow2(ar, ai, BLUE_M, 0);
  for (int m = 0; m < BLUE_M; m++) {
    double cr = ar[m] * blue_wr[m] - ai[m] * blue_wi[m];
    double ci = ar[m] * blue_wi[m] + ai[m] * blue_wr[m];
    ar[m] = cr; ai[m] = ci;
  }
  fft_pow2(ar, ai, BLUE_M, 1);
  for (int k = 0; k < N_FFT; k++) {
    /* X[k] = w[k] * c[k] */
    double wr = blue_chr[k], wi = blue_chi[k];
    Xr[k] = wr * ar[k] - wi * ai[k];
    Xi[k] = wr * ai[k] + wi * ar[k];
  }
}

/* ── slaney mel bank (mirrors HF audio_utils.mel_filter_bank) ──────────────────────────────────── */

static double mel_bank[N_MELS][N_FFT / 2 + 1];

static double hertz_to_mel(double f) {
  const double min_log_hertz = 1000.0, min_log_mel = 15.0, logstep = 27.0 / log(6.4);
  return f >= min_log_hertz ? min_log_mel + log(f / min_log_hertz) * logstep : 3.0 * f / 200.0;
}
static double mel_to_hertz(double m) {
  const double min_log_hertz = 1000.0, min_log_mel = 15.0, logstep = log(6.4) / 27.0;
  return m >= min_log_mel ? min_log_hertz * exp(logstep * (m - min_log_mel)) : 200.0 * m / 3.0;
}

static void mel_init(void) {
  static int ready = 0;
  if (ready) return;
  const int num_freq_bins = N_FFT / 2 + 1; /* 201 */
  const double min_freq = 0.0, max_freq = 8000.0;
  double mel_min = hertz_to_mel(min_freq), mel_max = hertz_to_mel(max_freq);
  double filter_freqs[N_MELS + 2];
  for (int i = 0; i < N_MELS + 2; i++)
    filter_freqs[i] = mel_to_hertz(mel_min + (mel_max - mel_min) * (double)i / (double)(N_MELS + 1));
  for (int b = 0; b < num_freq_bins; b++) {
    double fft_freq = (double)b / (double)(N_FFT / 2) * (SAMPLE_RATE / 2.0);
    for (int m = 0; m < N_MELS; m++) {
      double down = (fft_freq - filter_freqs[m]) / (filter_freqs[m + 1] - filter_freqs[m]);
      double up = (filter_freqs[m + 2] - fft_freq) / (filter_freqs[m + 2] - filter_freqs[m + 1]);
      double v = down < up ? down : up;
      if (v < 0) v = 0;
      double enorm = 2.0 / (filter_freqs[m + 2] - filter_freqs[m]);
      mel_bank[m][b] = v * enorm;
    }
  }
  ready = 1;
}

/* ── the front-end ─────────────────────────────────────────────────────────────────────────────── */

static void mel_features(const float *in, int in_len, float *out) {
  static double audio[N_SAMPLES];
  static double padded[N_SAMPLES + 2 * PAD];
  static double window[N_FFT];
  static double frame[N_FFT], fr[N_FFT], fi[N_FFT];
  static float buf[N_FRAMES][N_MELS];

  mel_init();
  for (int i = 0; i < N_FFT; i++) window[i] = 0.5 - 0.5 * cos(2.0 * M_PI * (double)i / (double)N_FFT);

  /* truncateToLastSeconds: last 8 s, left-padded with zeros when shorter */
  if (in_len >= N_SAMPLES) {
    for (int i = 0; i < N_SAMPLES; i++) audio[i] = (double)in[in_len - N_SAMPLES + i];
  } else {
    int off = N_SAMPLES - in_len;
    for (int i = 0; i < off; i++) audio[i] = 0.0;
    for (int i = 0; i < in_len; i++) audio[off + i] = (double)in[i];
  }
  /* reflect pad (numpy mode='reflect' — the edge sample is NOT repeated) */
  for (int i = 0; i < PAD; i++) padded[i] = audio[PAD - i];
  memcpy(padded + PAD, audio, sizeof(double) * N_SAMPLES);
  for (int i = 0; i < PAD; i++) padded[PAD + N_SAMPLES + i] = audio[N_SAMPLES - 2 - i];

  for (int f = 0; f < N_FRAMES; f++) {
    const double *base = padded + (size_t)f * HOP_LENGTH;
    for (int i = 0; i < N_FFT; i++) frame[i] = base[i] * window[i];
    dft400(frame, fr, fi);
    /* power spectrum once per frame (the naive form recomputed it inside the mel loop). */
    double power[N_FFT / 2 + 1];
    for (int k = 0; k <= N_FFT / 2; k++) power[k] = fr[k] * fr[k] + fi[k] * fi[k];
    for (int m = 0; m < N_MELS; m++) {
      double acc = 0.0;
      for (int k = 0; k <= N_FFT / 2; k++) acc += mel_bank[m][k] * power[k];
      double lg = log10(acc > MIN_LOG ? acc : MIN_LOG);
      buf[f][m] = (float)lg;
    }
  }
  float top = buf[0][0];
  for (int f = 0; f < N_FRAMES; f++)
    for (int m = 0; m < N_MELS; m++)
      if (buf[f][m] > top) top = buf[f][m];
  for (int m = 0; m < N_MELS; m++)
    for (int f = 0; f < N_FRAMES; f++) {
      float v = buf[f][m];
      if (v < top - 8.0f) v = top - 8.0f;
      out[m * N_FRAMES + f] = (v + 4.0f) / 4.0f;
    }
}

/* ── N-API surface ─────────────────────────────────────────────────────────────────────────────── */

static napi_value MelFeatures(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);

  bool is_ta = false;
  napi_is_typedarray(env, argv[0], &is_ta);
  if (!is_ta) {
    napi_throw_type_error(env, NULL, "melFeatures expects a Float32Array");
    return NULL;
  }
  napi_typedarray_type type;
  size_t length;
  void *data;
  napi_value ab;
  size_t byte_offset;
  napi_get_typedarray_info(env, argv[0], &type, &length, &data, &ab, &byte_offset);
  if (type != napi_float32_array) {
    napi_throw_type_error(env, NULL, "melFeatures expects a Float32Array");
    return NULL;
  }

  napi_value out_ab;
  void *out_data;
  napi_create_arraybuffer(env, sizeof(float) * N_MELS * N_FRAMES, &out_data, &out_ab);
  mel_features((const float *)data, (int)length, (float *)out_data);

  napi_value out;
  napi_create_typedarray(env, napi_float32_array, N_MELS * N_FRAMES, out_ab, 0, &out);
  return out;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "melFeatures", NAPI_AUTO_LENGTH, MelFeatures, NULL, &fn);
  napi_set_named_property(env, exports, "melFeatures", fn);
  napi_value dims;
  napi_create_array_with_length(env, 3, &dims);
  napi_value v;
  napi_create_int32(env, N_MELS, &v); napi_set_element(env, dims, 0, v);
  napi_create_int32(env, N_FRAMES, &v); napi_set_element(env, dims, 1, v);
  napi_create_int32(env, N_SAMPLES, &v); napi_set_element(env, dims, 2, v);
  napi_set_named_property(env, exports, "shape", dims);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
