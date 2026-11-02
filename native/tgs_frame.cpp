#include <rlottie.h>
#include <vector>
#include <string>
static std::vector<unsigned char> output;
static int width, height;
extern "C" int tgs_width() { return width; }
extern "C" int tgs_height() { return height; }
extern "C" unsigned char* render_tgs(const char* data, int length) {
  if (length < 1 || length > 4194304) return nullptr;
  auto animation = rlottie::Animation::loadFromData(std::string(data, length), "", "", false);
  if (!animation) return nullptr;
  size_t w, h;
  animation->size(w, h);
  if (!w || !h || w > 16000 || h > 16000 || w * h > 16000000) return nullptr;
  width = w; height = h;
  std::vector<uint32_t> pixels(w * h);
  rlottie::Surface surface(pixels.data(), w, h, w * 4);
  animation->renderSync(0, surface);
  output.resize(w * h * 3);
  for (size_t i = 0; i < pixels.size(); i++) {
    auto p = pixels[i]; unsigned white = 255 - (p >> 24);
    // rlottie ARGB channels are premultiplied; composite directly onto white.
    output[3*i] = ((p >> 16) & 255) + white;
    output[3*i+1] = ((p >> 8) & 255) + white;
    output[3*i+2] = (p & 255) + white;
  }
  return output.data();
}
