# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "cowsay>=6.1",
#     "example-lib",
# ]
#
# [tool.uv.sources]
# example-lib = { path = "../example-lib", editable = true }
# ///

import example_lib

def main():
    example_lib.hello()


if __name__ == "__main__":
    main()
