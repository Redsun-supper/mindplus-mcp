// ArduinoJson - https://arduinojson.org
// Copyright © 2014-2026, Benoit BLANCHON
// MIT License

#pragma once

#ifdef __cplusplus

// Guard against board macros that collide with VariantType enumerators
// (e.g. Mind+ MPython.h: #define Double 32 for note duration).
#ifdef Double
#undef Double
#endif

#  include "ArduinoJson.hpp"

using namespace ArduinoJson;

#else

#error ArduinoJson requires a C++ compiler, please change file extension to .cc or .cpp

#endif
