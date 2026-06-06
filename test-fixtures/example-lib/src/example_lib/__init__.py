import getpass
import cowsay

def hello() -> None:
    print("Hello from example-lib!")
    user = getpass.getuser()
    cowsay.cow(f"Whoami? You are currently logged in as: {user}")
