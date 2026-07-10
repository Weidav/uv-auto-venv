import getpass
from rich import print

def hello() -> None:
    print("[bold red]Hello[/bold red] from example-pkg!")
    user = getpass.getuser()
    print(f"Whoami? You are currently logged in as: {user}")
