document.addEventListener('DOMContentLoaded', () => {
  const navContainer = document.createElement('div');
  navContainer.id = 'sidebar-nav';
  navContainer.innerHTML = `
    <nav>
      <h3>Tournament App</h3>
      <ul>
        <li><a href="/registration">1. Registration</a></li>
        <li><a href="/standings">2. Standings</a></li>
        <li><a href="/pairings">3. Pairings</a></li>
      </ul>
    </nav>
    <hr>
  `;
  document.body.insertBefore(navContainer, document.body.firstChild);
});