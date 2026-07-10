# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "colorama>=0.4.6",
#     "example-lib",
# ]
#
# [tool.uv.sources]
# example-lib = { path = "../example-lib", editable = true }
# ///

import example_lib
import colorama

def main():
    colorama.init()
    example_lib.hello()


if __name__ == "__main__":
    main()
