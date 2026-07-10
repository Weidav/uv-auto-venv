import getpass
import pyfiglet

def hello() -> None:
    print("Hello from example-lib!")
    user = getpass.getuser()
    print(pyfiglet.figlet_format(f"Hello {user}"))
