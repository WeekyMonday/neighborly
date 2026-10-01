const registerForm = document.getElementById("registerForm");

if (registerForm) {
    registerForm.addEventListener("submit", (e) => {
        e.preventDefault();

        const name = document.getElementById("username").value.trim();
        const email = document.getElementById("email").value.trim();
        const password = document.getElementById("password").value;

        if (!name || !email || password.length < 6) {
            alert('Please fill in all fields with a valid password.');
            return;
        }

        const users = JSON.parse(localStorage.getItem('neighborly_users') || '[]');
        if (users.some((user) => user.email.toLowerCase() === email.toLowerCase())) {
            alert('An account with that email already exists.');
            return;
        }

        const newUser = {
            name,
            email,
            password,
            handle: name.toLowerCase().replace(/\s+/g, '.').replace(/[^a-z0-9.]/g, ''),
            initials: name.split(' ').filter(Boolean).slice(0, 2).map(part => part[0].toUpperCase()).join('') || 'U'
        };

        users.push(newUser);
        localStorage.setItem('neighborly_users', JSON.stringify(users));
        localStorage.setItem('neighborly_session', JSON.stringify({ email: newUser.email, name: newUser.name, handle: newUser.handle }));
        window.location.href = "Neighborly.html";
    });
}