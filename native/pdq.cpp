#include <pdq/cpp/hashing/pdqhashing.h>
#include <vector>
// Exact reference RGB/luma pipeline. Output hex uses the reference word order.
extern "C" int pdq_hash_rgb(unsigned char* rgb, int width, int height, char* output) {
  if (width < 1 || height < 1 || (long long)width * height > 16000000) return -1;
  std::vector<float> a(width * height), b(width * height);
  float c[64][64], d[16][64], e[16][16];
  facebook::pdq::hashing::Hash256 hash;
  int quality;
  facebook::pdq::hashing::fillFloatLumaFromRGB(rgb, rgb + 1, rgb + 2, height, width, width * 3, 3, a.data());
  facebook::pdq::hashing::pdqHash256FromFloatLuma(a.data(), b.data(), height, width, c, d, e, hash, quality);
  const char* hex = "0123456789abcdef";
  for (int i = 0; i < 16; ++i) for (int j = 0; j < 4; ++j) output[i * 4 + j] = hex[(hash.w[15-i] >> (12-4*j)) & 15];
  output[64] = 0;
  return quality;
}
