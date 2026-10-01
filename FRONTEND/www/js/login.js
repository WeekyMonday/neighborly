const loginForm = document.getElementById("loginForm");

if (loginForm) {
    loginForm.addEventListener("submit", (e) => {
        e.preventDefault();

        const email = document.getElementById("email").value.trim();
        const password = document.getElementById("password").value;
        const users = JSON.parse(localStorage.getItem('neighborly_users') || '[]');
        const match = users.find((user) => user.email.toLowerCase() === email.toLowerCase() && user.password === password);

        if (!match) {
            alert('Invalid email or password.');
            return;
        }

        localStorage.setItem('neighborly_session', JSON.stringify({ email: match.email, name: match.name, handle: match.handle }));
        window.location.href = "Neighborly.html";
    });
}