import getpass
import cowsay

def main():
    print("Hello from example-bare!")
    user = getpass.getuser()
    cowsay.cow(f"Whoami? You are currently logged in as: {user}")

if __name__ == "__main__":
    main()
