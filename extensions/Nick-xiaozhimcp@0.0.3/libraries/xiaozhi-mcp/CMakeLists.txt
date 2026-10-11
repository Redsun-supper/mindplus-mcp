# CMakeLists.txt for xiaozhi_mcp library
#
# This file is used for building the library with ESP-IDF.

# Specify source file directories
set(COMPONENT_SRCDIRS
    "src"
)

# Specify include directories
set(COMPONENT_ADD_INCLUDEDIRS
    "src"
)

# Specify required components
set(COMPONENT_REQUIRES
    "arduino-esp32"
    "AsyncTCP"
    "ArduinoJson"
    "WebSockets"
    "WiFi"
)

# Register the component
register_component()

# Add compile definitions
target_compile_definitions(${COMPONENT_TARGET} PUBLIC -DESP32)

# Add compile options
target_compile_options(${COMPONENT_TARGET} PRIVATE -fno-rtti)

# Add examples
option(BUILD_EXAMPLES "Build examples" OFF)
if(BUILD_EXAMPLES)
    add_subdirectory(examples)
endif()