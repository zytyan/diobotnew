// Memory-only, decode-only FFmpeg/libvpx entry point. No protocols or filesystem.
#include <stdint.h>
#include <string.h>
#include <stdlib.h>
#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
#include <libavutil/imgutils.h>
#include <libswscale/swscale.h>

typedef struct { const uint8_t *data; int64_t size, pos; } Reader;
static uint8_t *output;
static int output_width, output_height, output_orientation;
int media_orientation(void) { return output_orientation; }
int media_width(void) { return output_width; }
int media_height(void) { return output_height; }
uint8_t *media_pixels(void) { return output; }
static int read_bytes(void *opaque, uint8_t *buffer, int count) {
  Reader *r = opaque;
  if (r->pos >= r->size) return AVERROR_EOF;
  if (count > r->size - r->pos) count = r->size - r->pos;
  memcpy(buffer, r->data + r->pos, count); r->pos += count;
  return count;
}
static int64_t seek_bytes(void *opaque, int64_t offset, int whence) {
  Reader *r = opaque;
  if (whence == AVSEEK_SIZE) return r->size;
  whence &= ~AVSEEK_FORCE;
  int64_t base = whence == SEEK_SET ? 0 : whence == SEEK_CUR ? r->pos : whence == SEEK_END ? r->size : -1;
  if (base < 0 || offset < -base || offset > r->size - base) return AVERROR(EINVAL);
  r->pos = base + offset; return r->pos;
}
int decode_media(uint8_t *data, int length, int webm) {
  av_freep(&output); output_width = output_height = 0; output_orientation = 1;
  if (length <= 0 || length > 20 * 1024 * 1024) return -1;
  av_log_set_level(AV_LOG_QUIET);
  Reader reader = { data, length, 0 };
  AVFormatContext *format = avformat_alloc_context();
  AVIOContext *io = NULL;
  AVCodecContext *decoder = NULL;
  AVPacket *packet = NULL;
  AVFrame *frame = NULL;
  struct SwsContext *scale = NULL;
  int result = -1, index = -1, received = 0;
  uint8_t *buffer = av_malloc(32768);
  if (!format || !buffer) goto done;
  io = avio_alloc_context(buffer, 32768, 0, &reader, read_bytes, NULL, seek_bytes);
  if (!io) { av_free(buffer); goto done; }
  format->pb = io; format->flags |= AVFMT_FLAG_CUSTOM_IO;
  format->max_streams = 8;
  const AVInputFormat *input = NULL;
  if (webm) input = av_find_input_format("matroska");
  else if (length > 2 && data[0] == 0xff && data[1] == 0xd8) input = av_find_input_format("jpeg_pipe");
  else if (length > 8 && !memcmp(data, "\x89PNG\r\n\x1a\n", 8)) input = av_find_input_format("png_pipe");
  else if (length > 12 && !memcmp(data, "RIFF", 4) && !memcmp(data+8, "WEBP", 4)) input = av_find_input_format("webp_pipe");
  else if (length > 2 && data[0] == 'P' && data[1] == '6') input = av_find_input_format("ppm_pipe");
  if (!input || avformat_open_input(&format, NULL, input, NULL) < 0) goto done;
  for (unsigned i = 0; i < format->nb_streams; i++) {
    if (format->streams[i]->codecpar->codec_type == AVMEDIA_TYPE_VIDEO) { index = i; break; }
  }
  if (index < 0) goto done;
  AVCodecParameters *parameters = format->streams[index]->codecpar;
  if (parameters->width > 0 && parameters->height > 0 && (int64_t)parameters->width * parameters->height > 16000000) goto done;
  const AVCodec *codec = parameters->codec_id == AV_CODEC_ID_VP9 ? avcodec_find_decoder_by_name("libvpx-vp9")
    : parameters->codec_id == AV_CODEC_ID_VP8 ? avcodec_find_decoder_by_name("libvpx") : avcodec_find_decoder(parameters->codec_id);
  if (!codec || !(decoder = avcodec_alloc_context3(codec))) goto done;
  decoder->max_pixels = 16000000;
  decoder->thread_count = 1;
  decoder->thread_type = 0;
  if (avcodec_parameters_to_context(decoder, parameters) < 0 || avcodec_open2(decoder, codec, NULL) < 0) goto done;
  packet = av_packet_alloc(); frame = av_frame_alloc();
  if (!packet || !frame) goto done;
  while (av_read_frame(format, packet) >= 0) {
    if (packet->stream_index == index) {
      if (avcodec_send_packet(decoder, packet) < 0) goto done;
      int status = avcodec_receive_frame(decoder, frame);
      if (!status) { received = 1; break; }
      if (status != AVERROR(EAGAIN)) goto done;
    }
    av_packet_unref(packet);
  }
  if (!received) {
    if (avcodec_send_packet(decoder, NULL) < 0 || avcodec_receive_frame(decoder, frame) < 0) goto done;
  }
  const AVDictionaryEntry *orientation = av_dict_get(frame->metadata, "Orientation", NULL, 0);
  if (orientation && av_frame_get_side_data(frame, AV_FRAME_DATA_DISPLAYMATRIX)) {
    int value = atoi(orientation->value);
    if (value >= 2 && value <= 8) output_orientation = value;
  }
  int w = frame->width, h = frame->height;
  if (w <= 0 || h <= 0 || (int64_t)w * h > 16000000) goto done;
  output = av_malloc((size_t)w * h * 4);
  if (!output) goto done;
  scale = sws_getContext(w, h, frame->format, w, h, AV_PIX_FMT_RGBA, SWS_BICUBIC, NULL, NULL, NULL);
  if (!scale) goto done;
  int colorspace = frame->colorspace == AVCOL_SPC_BT709 ? SWS_CS_ITU709 : frame->colorspace == AVCOL_SPC_BT2020_NCL ? SWS_CS_BT2020 : SWS_CS_DEFAULT;
  const int *coefficients = sws_getCoefficients(colorspace);
  sws_setColorspaceDetails(scale, coefficients, frame->color_range == AVCOL_RANGE_JPEG, coefficients, 1, 0, 1<<16, 1<<16);
  uint8_t *dest[4] = {output, NULL, NULL, NULL}; int stride[4] = {w*4, 0, 0, 0};
  if (sws_scale(scale, (const uint8_t * const *)frame->data, frame->linesize, 0, h, dest, stride) != h) goto done;
  output_width = w; output_height = h; result = 0;
done:
  sws_freeContext(scale);
  av_frame_free(&frame); av_packet_free(&packet); avcodec_free_context(&decoder);
  avformat_close_input(&format);
  if (io) { av_freep(&io->buffer); avio_context_free(&io); }
  if (result) av_freep(&output);
  return result;
}
