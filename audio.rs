// audio.rs — System audio loopback capture via CPAL
//
// Windows: WASAPI loopback on the default output device (no virtual cable needed)
// macOS:   Requires BlackHole or similar virtual audio device as the input source;
//          pure CoreAudio loopback is not available without an extension.
//
// Cargo.toml additions required:
//   cpal = "0.15"

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, SampleRate, StreamConfig};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tokio::sync::mpsc;

/// Mono PCM16 audio chunk (raw bytes, little-endian).
pub type AudioChunk = Vec<u8>;

pub struct AudioCapture {
    running: Arc<AtomicBool>,
}

impl AudioCapture {
    pub fn new() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Start capturing loopback audio and return a channel receiver.
    ///
    /// Each message is a `Vec<u8>` containing raw PCM16 mono samples at
    /// `target_sample_rate` Hz (resampled from the device rate if necessary).
    ///
    /// The stream runs in a background thread; call `stop()` to tear it down.
    pub fn start(
        &self,
        device_name: Option<&str>,
        target_sample_rate: u32,
    ) -> Result<mpsc::UnboundedReceiver<AudioChunk>, Box<dyn std::error::Error + Send + Sync>> {
        let running = Arc::clone(&self.running);
        running.store(true, Ordering::SeqCst);

        let (tx, rx) = mpsc::unbounded_channel::<AudioChunk>();

        let device_name = device_name.map(str::to_string);

        std::thread::spawn(move || {
            if let Err(e) = run_capture(tx, running, device_name, target_sample_rate) {
                log::error!("Audio capture thread error: {}", e);
            }
        });

        Ok(rx)
    }

    pub fn stop(&self) {
        self.running.store(false, Ordering::SeqCst);
    }
}

// ─── Capture implementation ───────────────────────────────────────────────────

fn run_capture(
    tx: mpsc::UnboundedSender<AudioChunk>,
    running: Arc<AtomicBool>,
    device_name: Option<String>,
    target_hz: u32,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let host = cpal::default_host();

    // ── Device selection ──────────────────────────────────────────────────────
    let device = match &device_name {
        Some(name) => host
            .input_devices()?
            .find(|d| d.name().map(|n| n == *name).unwrap_or(false))
            .ok_or_else(|| format!("Audio device '{}' not found", name))?,
        None => {
            // On Windows prefer the loopback of the default output; CPAL
            // exposes this as an input device named "Stereo Mix" or similar.
            // On macOS this will be the default input (microphone or BlackHole).
            host.default_input_device()
                .ok_or("No default input device")?
        }
    };

    log::info!(
        "Audio capture: device = '{}'",
        device.name().unwrap_or_default()
    );

    let supported = device.default_input_config()?;
    let device_hz = supported.sample_rate().0;
    let device_channels = supported.channels() as usize;
    let sample_format = supported.sample_format();

    let config = StreamConfig {
        channels: supported.channels(),
        sample_rate: SampleRate(device_hz),
        buffer_size: cpal::BufferSize::Default,
    };

    log::debug!(
        "Capture config: {}ch @ {}Hz ({:?})",
        device_channels,
        device_hz,
        sample_format
    );

    // ── Build stream ──────────────────────────────────────────────────────────
    let stream = match sample_format {
        SampleFormat::F32 => build_stream::<f32>(&device, &config, tx, running, device_hz, device_channels, target_hz),
        SampleFormat::I16 => build_stream::<i16>(&device, &config, tx, running, device_hz, device_channels, target_hz),
        SampleFormat::U16 => build_stream::<u16>(&device, &config, tx, running, device_hz, device_channels, target_hz),
        _ => return Err("Unsupported sample format".into()),
    }?;

    stream.play()?;
    log::info!("Audio capture: stream started");

    // Keep thread alive while running
    while running.load(Ordering::SeqCst) {
        std::thread::sleep(std::time::Duration::from_millis(50));
    }

    log::info!("Audio capture: stream stopping");
    drop(stream);
    Ok(())
}

fn build_stream<S>(
    device: &cpal::Device,
    config: &StreamConfig,
    tx: mpsc::UnboundedSender<AudioChunk>,
    running: Arc<AtomicBool>,
    device_hz: u32,
    channels: usize,
    target_hz: u32,
) -> Result<cpal::Stream, cpal::BuildStreamError>
where
    S: cpal::Sample + cpal::SizedSample + Send + 'static,
    f32: From<S>,
{
    device.build_input_stream(
        config,
        move |data: &[S], _| {
            if !running.load(Ordering::Relaxed) {
                return;
            }

            // 1. Convert to f32 mono
            let mono: Vec<f32> = if channels == 1 {
                data.iter().map(|&s| f32::from(s)).collect()
            } else {
                data.chunks(channels)
                    .map(|frame| frame.iter().map(|&s| f32::from(s)).sum::<f32>() / channels as f32)
                    .collect()
            };

            // 2. Resample if device rate ≠ target rate (simple linear interpolation)
            let resampled: Vec<f32> = if device_hz == target_hz {
                mono
            } else {
                let ratio = device_hz as f64 / target_hz as f64;
                let out_len = (mono.len() as f64 / ratio).ceil() as usize;
                (0..out_len)
                    .map(|i| {
                        let src = i as f64 * ratio;
                        let idx = src as usize;
                        let frac = src - idx as f64;
                        let a = mono.get(idx).copied().unwrap_or(0.0);
                        let b = mono.get(idx + 1).copied().unwrap_or(a);
                        (a as f64 * (1.0 - frac) + b as f64 * frac) as f32
                    })
                    .collect()
            };

            // 3. Encode as PCM16 little-endian
            let mut pcm = Vec::with_capacity(resampled.len() * 2);
            for sample in resampled {
                let s16 = (sample.clamp(-1.0, 1.0) * 32767.0) as i16;
                pcm.extend_from_slice(&s16.to_le_bytes());
            }

            let _ = tx.send(pcm);
        },
        |err| log::error!("Audio stream error: {}", err),
        None,
    )
}
